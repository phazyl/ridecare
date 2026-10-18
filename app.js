/* Greater Malé road capacity simulator
 * Plain JS, no build step.
 *  - data/network.json  (made by tools/export_network.py)  -> street geometry; placeholder grid if missing
 *  - data/years.json    (fleet index + police accident series) -> Year Slider and collision model
 */
(() => {
'use strict';

/* =====================================================================
 * 1. CONFIG - edit these to change defaults
 * ===================================================================== */
const AREA = { min: 0.80, max: 1.00, step: 0.001, osmnx: 0.894, report: 0.902 };
const DEFAULTS = { parkShare: 0, parkStrip: 2.3, jam: 0.50, simSpeed: 10, dotPx: 2 };
const MAX_VEHICLES = 400000;
const TODAY_TOTAL = 119093; // Table 3 = the 2024 baseline fleet

// physics / placement
const PHYS = {
  cell: 6,            // spatial-hash cell (m)
  gap: 0.1,           // minimum clearance between any two vehicles (m)
  tries: 80,          // placement attempts per vehicle
  failStreak: 1500,   // give up on a type after this many consecutive failures
  budgetMs: 3000,     // max time for one placement burst (ms)
  subDt: 0.12,        // max physics sub-step (s)
  maxSub: 3,          // max sub-steps per frame
  relaneAfter: 2,     // s blocked before a vehicle tries another lateral position
  reverseAfter: 12,   // s blocked before a vehicle tries to turn round
};

// collision model defaults
const COL = { beta: 1.5, secPerDay: 20, share: 0.8, baseAcc: 2882, baseFleet: 119093 };

const TYPES = [
  { id: 'moto',    name: 'Motorcycles',       count: 103300, proposed: 76518, L: 2.0, W: 0.8, v: 7.5, color: '#ffa62b', max: 200000, step: 100 },
  { id: 'car',     name: 'Cars',              count: 7505,   proposed: 5610,  L: 4.4, W: 1.8, v: 6.5, color: '#2ec4b6', max: 20000 },
  { id: 'pickup',  name: 'Pickups',           count: 2050,   proposed: 1533,  L: 5.2, W: 1.9, v: 6.0, color: '#ff4d5e', max: 6000 },
  { id: 'scooter', name: 'Battery scooters',  count: 1473,   proposed: 1473,  L: 1.8, W: 0.7, v: 5.0, color: '#b57bff', max: 6000 },
  { id: 'van',     name: 'Vans',              count: 1374,   proposed: 1027,  L: 4.8, W: 1.9, v: 6.0, color: '#34c3ff', max: 6000 },
  { id: 'truck',   name: 'Trucks',            count: 748,    proposed: 559,   L: 7.0, W: 2.3, v: 5.0, color: '#ff7ac6', max: 4000 },
  { id: 'ebike',   name: 'Electric bicycles', count: 453,    proposed: 339,   L: 1.7, W: 0.6, v: 4.5, color: '#9be32f', max: 4000 },
  { id: 'lorry',   name: 'Lorries (cargo)',   count: 435,    proposed: 325,   L: 8.0, W: 2.4, v: 5.0, color: '#ff8a8a', max: 3000 },
  { id: 'jeep',    name: 'Jeeps',             count: 354,    proposed: 265,   L: 4.4, W: 1.9, v: 6.0, color: '#ffe14d', max: 2000 },
  { id: 'bus',     name: 'Buses',             count: 151,    proposed: 151,   L: 9.0, W: 2.5, v: 5.5, color: '#8f7cff', max: 1000 },
  { id: 'other',   name: 'Other / industrial', count: 1250,  proposed: 1613,  L: 6.0, W: 2.4, v: 4.5, color: '#b8c2cc', max: 6000 },
];

const PRESETS = [
  { label: 'Today · 119,093',            total: 119093 },
  { label: 'Roadworthy only · 100,175',  total: 100175 },
  { label: 'Report proposal · 89,413',   proposed: true },
  { label: 'Population-based · 81,138',  total: 81138 },
  { label: 'Road-space-based · 51,905',  total: 51905 },
  { label: 'Empty',                      total: 0 },
];

const HEAT = ['#232c38', '#2b4a45', '#3f6b3a', '#7b7a25', '#a8691f', '#c2411f', '#d71f2e'];

const STATUS_TXT = {
  baseline:   'IUM report baseline fleet (2024).',
  nbs_shape:  'Trend follows NBS registrations (national), scaled to the 2024 Greater Malé fleet.',
  estimate:   'Estimate. This year is not in the published NBS table (it ends 2023).',
  assumption: 'Includes an assumption: part of the fleet has no source for this year.',
};
const STATUS_RANK = { baseline: 0, nbs_shape: 1, estimate: 2, assumption: 3 };
const STATUS_COL = ['#3fb950', '#3fb6ff', '#e3a008', '#f85149'];

/* =====================================================================
 * 2. STATE
 * ===================================================================== */
const $ = (id) => document.getElementById(id);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const nT = TYPES.length;
const counts = new Int32Array(nT);
const placed = new Int32Array(nT);
const FP = new Float32Array(nT);
const TV = new Float32Array(nT);
const HL = new Float32Array(nT);
const HW = new Float32Array(nT);
const RAD = new Float32Array(nT);
let RMAX = 0;

const state = {
  areaKm2: AREA.osmnx, parkShare: DEFAULTS.parkShare / 100, parkStrip: DEFAULTS.parkStrip,
  jam: DEFAULTS.jam, simSpeed: DEFAULTS.simSpeed, dotPx: DEFAULTS.dotPx,
  paused: false, heat: true, slow: false, dirty: true, synthetic: false,
  year: 2024, yearCustom: false,
  beta: COL.beta, share: COL.share, secPerDay: COL.secPerDay, colOn: true,
};

function refreshType(i) {
  const t = TYPES[i];
  FP[i] = t.L * t.W; TV[i] = t.v;
  HL[i] = t.L / 2 + PHYS.gap / 2; HW[i] = t.W / 2 + PHYS.gap / 2;
  RAD[i] = Math.hypot(HL[i], HW[i]);
}
TYPES.forEach((_, i) => refreshType(i));
function updateRmax() {
  RMAX = 0;
  for (let t = 0; t < nT; t++) if (placed[t] > 0 && RAD[t] > RMAX) RMAX = RAD[t];
}

let net = null;
let G = null;
const dirtyCells = new Int32Array(MAX_VEHICLES);
let dirtyCount = 0;

let initialised = false;
let yearsCfg = null;
let fit = null;
const V = {
  n: 0,
  e: new Int32Array(MAX_VEHICLES), s: new Float32Array(MAX_VEHICLES), dir: new Int8Array(MAX_VEHICLES),
  jit: new Float32Array(MAX_VEHICLES), type: new Uint8Array(MAX_VEHICLES), lat: new Float32Array(MAX_VEHICLES),
  park: new Float32Array(MAX_VEHICLES), side: new Int8Array(MAX_VEHICLES), stuck: new Float32Array(MAX_VEHICLES),
  x: new Float32Array(MAX_VEHICLES), y: new Float32Array(MAX_VEHICLES),
  hx: new Float32Array(MAX_VEHICLES), hy: new Float32Array(MAX_VEHICLES),
};
const PARKED = new Uint8Array(MAX_VEHICLES);
const SX = new Float32Array(MAX_VEHICLES), SY = new Float32Array(MAX_VEHICLES), VIS = new Uint8Array(MAX_VEHICLES);
let stats = { mv: 0, parkedN: 0, parkedFP: 0, sumV: 0, sumF: 0, congArea: 0, blockedN: 0 };
const run = { events: 0, days: 0 };
const markers = [];

/* =====================================================================
 * 3. NETWORK
 * ===================================================================== */
function makeSyntheticNetwork() {
  const nodes = [], edges = [], idx = new Map();
  const nid = (x, y) => {
    const k = x + ',' + y; let i = idx.get(k);
    if (i === undefined) { i = nodes.length; nodes.push([x, y]); idx.set(k, i); }
    return i;
  };
  const seg = (x0, y0, x1, y1, w) => edges.push({ u: nid(x0, y0), v: nid(x1, y1), w, p: [x0, y0, x1, y1] });
  const grid = (x0, y0, x1, y1, dx, dy, wMain, wSide, every) => {
    const xs = [], ys = [];
    for (let x = x0; x <= x1; x += dx) xs.push(x);
    for (let y = y0; y <= y1; y += dy) ys.push(y);
    ys.forEach((y, j) => { const w = j % every === 0 ? wMain : wSide; for (let i = 0; i < xs.length - 1; i++) seg(xs[i], y, xs[i + 1], y, w); });
    xs.forEach((x, i) => { const w = i % every === 0 ? wMain : wSide; for (let j = 0; j < ys.length - 1; j++) seg(x, ys[j], x, ys[j + 1], w); });
  };
  grid(0, 0, 1700, 840, 85, 70, 11, 6, 4);
  grid(3300, 2900, 4100, 6300, 100, 136, 12, 7, 4);
  const bridge = [[1700, 420], [2300, 1000], [2700, 1800], [3000, 2400], [3300, 2900]];
  for (let i = 0; i < bridge.length - 1; i++) seg(...bridge[i], ...bridge[i + 1], 14);
  seg(2700, 1800, 2550, 2300, 10); seg(2550, 2300, 3000, 2400, 10);
  return { meta: { synthetic: true }, nodes, edges };
}

async function loadJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (err) { return null; }
}

function prepareNetwork(raw) {
  const E = raw.edges.length, N = raw.nodes.length;
  let P = 0; for (const e of raw.edges) P += e.p.length / 2;
  const n = {
    E, N,
    u: new Int32Array(E), v: new Int32Array(E), w0: new Float32Array(E), len: new Float32Array(E),
    off: new Int32Array(E + 1),
    px: new Float32Array(P), py: new Float32Array(P), cum: new Float32Array(P),
    bx0: new Float32Array(E), by0: new Float32Array(E), bx1: new Float32Array(E), by1: new Float32Array(E),
    ewS: new Float32Array(E), Ae: new Float32Array(E), cumArea: new Float64Array(E),
    bounds: [Infinity, Infinity, -Infinity, -Infinity],
  };
  let k = 0, sumA = 0;
  raw.edges.forEach((e, i) => {
    n.u[i] = e.u; n.v[i] = e.v; n.w0[i] = e.w; n.off[i] = k;
    let c = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < e.p.length; j += 2) {
      const x = e.p[j], y = e.p[j + 1];
      if (j > 0) c += Math.hypot(x - n.px[k - 1], y - n.py[k - 1]);
      n.px[k] = x; n.py[k] = y; n.cum[k] = c; k++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    n.len[i] = Math.max(c, 0.01);
    n.bx0[i] = x0; n.by0[i] = y0; n.bx1[i] = x1; n.by1[i] = y1;
    n.bounds[0] = Math.min(n.bounds[0], x0); n.bounds[1] = Math.min(n.bounds[1], y0);
    n.bounds[2] = Math.max(n.bounds[2], x1); n.bounds[3] = Math.max(n.bounds[3], y1);
    sumA += n.len[i] * e.w;
    n.cumArea[i] = sumA;
  });
  n.off[E] = k;
  const union = raw.meta && raw.meta.area_m2 ? raw.meta.area_m2 : sumA;
  n.baseUnion = union;
  n.kappa = union / sumA;
  n.totalWeight = sumA;

  const deg = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) { deg[n.u[i] + 1]++; deg[n.v[i] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  n.adjOff = deg.slice();
  n.adjE = new Int32Array(deg[N]);
  const fill = deg.slice(0, N);
  for (let i = 0; i < E; i++) { n.adjE[fill[n.u[i]]++] = i; n.adjE[fill[n.v[i]]++] = i; }

  n.occ = new Float32Array(E); n.cov = new Float32Array(E); n.spdF = new Float32Array(E).fill(1);
  n.bkt = new Uint8Array(E);
  return n;
}

function applyRoadArea() {
  const scale = (state.areaKm2 * 1e6) / net.baseUnion;
  net.widthScale = scale;
  for (let i = 0; i < net.E; i++) {
    net.ewS[i] = net.w0[i] * scale;
    net.Ae[i] = net.len[i] * net.ewS[i] * net.kappa;
  }
  state.dirty = true;
  if (initialised) scheduleReplace();
}

function sampleEdge() {
  const r = Math.random() * net.totalWeight;
  let lo = 0, hi = net.E - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (net.cumArea[m] < r) lo = m + 1; else hi = m; }
  return lo;
}

function pickNext(node, from) {
  const a = net.adjOff[node], b = net.adjOff[node + 1];
  let tot = 0;
  for (let k = a; k < b; k++) { const ee = net.adjE[k]; if (ee !== from) tot += net.w0[ee]; }
  if (tot <= 0) return -1;
  let r = Math.random() * tot, last = -1;
  for (let k = a; k < b; k++) {
    const ee = net.adjE[k]; if (ee === from) continue;
    last = ee; r -= net.w0[ee]; if (r <= 0) return ee;
  }
  return last;
}

/* =====================================================================
 * 4. GEOMETRY & SPATIAL HASH
 * ===================================================================== */
let PX = 0, PY = 0, PHX = 1, PHY = 0;

function pose(e, s, dir, lat, parked, side, t) {
  const o = net.off[e], last = net.off[e + 1] - 1, cum = net.cum;
  let k = o;
  while (k < last - 1 && cum[k + 1] < s) k++;
  const x0 = net.px[k], y0 = net.py[k];
  const sl = cum[k + 1] - cum[k];
  let dx = 1, dy = 0, tt = 0;
  if (sl > 1e-6) { dx = (net.px[k + 1] - x0) / sl; dy = (net.py[k + 1] - y0) / sl; tt = s - cum[k]; }
  const W = net.ewS[e];
  let latM;
  if (parked) latM = side * Math.max(0, W * 0.5 - state.parkStrip * 0.5);
  else latM = dir * lat * Math.max(0, W * 0.5 - TYPES[t].W * 0.5 - (state.parkShare > 0 ? state.parkStrip : 0));
  PX = x0 + dx * tt - dy * latM;
  PY = y0 + dy * tt + dx * latM;
  PHX = dir * dx; PHY = dir * dy;
}

function buildGrid() {
  const [x0, y0, x1, y1] = net.bounds, pad = 30;
  let cs = PHYS.cell, nx, ny;
  for (;;) {
    nx = Math.ceil((x1 - x0 + 2 * pad) / cs); ny = Math.ceil((y1 - y0 + 2 * pad) / cs);
    if (nx * ny <= 3e6) break;
    cs *= 1.5;
  }
  G = { cs, nx, ny, x0: x0 - pad, y0: y0 - pad, head: new Int32Array(nx * ny).fill(-1), next: new Int32Array(MAX_VEHICLES) };
  dirtyCount = 0;
}

function rebuildGrid() {
  const { head, next, cs, nx, ny, x0, y0 } = G;
  for (let k = 0; k < dirtyCount; k++) head[dirtyCells[k]] = -1;
  dirtyCount = 0;

  for (let i = 0; i < V.n; i++) {
    let cx = Math.floor((V.x[i] - x0) / cs), cy = Math.floor((V.y[i] - y0) / cs);
    if (cx < 0) cx = 0; else if (cx >= nx) cx = nx - 1;
    if (cy < 0) cy = 0; else if (cy >= ny) cy = ny - 1;
    const c = cy * nx + cx;
    if (head[c] === -1) dirtyCells[dirtyCount++] = c;
    next[i] = head[c]; head[c] = i;
  }
}

function gridInsert(i) {
  let cx = Math.floor((V.x[i] - G.x0) / G.cs), cy = Math.floor((V.y[i] - G.y0) / G.cs);
  if (cx < 0) cx = 0; else if (cx >= G.nx) cx = G.nx - 1;
  if (cy < 0) cy = 0; else if (cy >= G.ny) cy = G.ny - 1;
  const c = cy * G.nx + cx;
  if (G.head[c] === -1) dirtyCells[dirtyCount++] = c;
  G.next[i] = G.head[c]; G.head[c] = i;
}

function sep(ux, uy, dx, dy, aL, aW, ahx, ahy, bL, bW, bhx, bhy) {
  const d = Math.abs(dx * ux + dy * uy);
  const ra = aL * Math.abs(ahx * ux + ahy * uy) + aW * Math.abs(-ahy * ux + ahx * uy);
  const rb = bL * Math.abs(bhx * ux + bhy * uy) + bW * Math.abs(-bhy * ux + bhx * uy);
  return d > ra + rb;
}

function rectsOverlap(ax, ay, ahx, ahy, aL, aW, bx, by, bhx, bhy, bL, bW) {
  const dx = bx - ax, dy = by - ay;
  if (sep(ahx, ahy, dx, dy, aL, aW, ahx, ahy, bL, bW, bhx, bhy)) return false;
  if (sep(-ahy, ahx, dx, dy, aL, aW, ahx, ahy, bL, bW, bhx, bhy)) return false;
  if (sep(bhx, bhy, dx, dy, aL, aW, ahx, ahy, bL, bW, bhx, bhy)) return false;
  if (sep(-bhy, bhx, dx, dy, aL, aW, ahx, ahy, bL, bW, bhx, bhy)) return false;
  return true;
}

function overlapsAny(x, y, hx, hy, t, self) {
  const cs = G.cs, nx = G.nx, ny = G.ny;
  const reach = RAD[t] + RMAX + 1.5;
  let cx0 = Math.floor((x - reach - G.x0) / cs), cx1 = Math.floor((x + reach - G.x0) / cs);
  let cy0 = Math.floor((y - reach - G.y0) / cs), cy1 = Math.floor((y + reach - G.y0) / cs);
  if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= nx) cx1 = nx - 1; if (cy1 >= ny) cy1 = ny - 1;
  const aL = HL[t], aW = HW[t], r = RAD[t];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      let j = G.head[cy * nx + cx];
      while (j !== -1) {
        if (j !== self) {
          const tj = V.type[j], dx = V.x[j] - x, dy = V.y[j] - y, rr = r + RAD[tj];
          if (dx * dx + dy * dy < rr * rr &&
              rectsOverlap(x, y, hx, hy, aL, aW, V.x[j], V.y[j], V.hx[j], V.hy[j], HL[tj], HW[tj])) return true;
        }
        j = G.next[j];
      }
    }
  }
  return false;
}

/* =====================================================================
 * 5. VEHICLE MANAGEMENT
 * ===================================================================== */
function tryPlace(t) {
  if (V.n >= MAX_VEHICLES) return false;
  const i = V.n, ps = state.parkShare;
  
  for (let k = 0; k < PHYS.tries; k++) {
    const e = sampleEdge(), s = Math.random() * net.len[e];
    const dir = Math.random() < 0.5 ? 1 : -1, lat = Math.random(), side = Math.random() < 0.5 ? 1 : -1;
    const pk = Math.random(), parked = pk < ps;
    pose(e, s, dir, lat, parked, side, t);
    if (!overlapsAny(PX, PY, PHX, PHY, t, -1)) {
      V.e[i] = e; V.s[i] = s; V.dir[i] = dir; V.lat[i] = lat; V.side[i] = side; V.park[i] = pk;
      V.jit[i] = 0.8 + 0.4 * Math.random(); V.type[i] = t; V.stuck[i] = 0; PARKED[i] = parked ? 1 : 0;
      V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY;
      gridInsert(i); V.n++;
      return true;
    }
  }

  const stepS = TYPES[t].L + PHYS.gap;
  for (let k = 0; k < 5; k++) {
    const e = sampleEdge();
    for (let s = 0; s < net.len[e]; s += stepS) {
      const dir = Math.random() < 0.5 ? 1 : -1, side = Math.random() < 0.5 ? 1 : -1;
      const pk = Math.random(), parked = pk < ps;
      for (const lat of [0, 0.5, 1]) {
        pose(e, s, dir, lat, parked, side, t);
        if (!overlapsAny(PX, PY, PHX, PHY, t, -1)) {
          V.e[i] = e; V.s[i] = s; V.dir[i] = dir; V.lat[i] = lat; V.side[i] = side; V.park[i] = pk;
          V.jit[i] = 0.8 + 0.4 * Math.random(); V.type[i] = t; V.stuck[i] = 0; PARKED[i] = parked ? 1 : 0;
          V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY;
          gridInsert(i); V.n++;
          return true;
        }
      }
    }
  }
  return false;
}

function moveVehicle(dst, src) {
  V.e[dst] = V.e[src]; V.s[dst] = V.s[src]; V.dir[dst] = V.dir[src]; V.jit[dst] = V.jit[src];
  V.type[dst] = V.type[src]; V.lat[dst] = V.lat[src]; V.park[dst] = V.park[src]; V.side[dst] = V.side[src];
  V.stuck[dst] = V.stuck[src]; PARKED[dst] = PARKED[src];
  V.x[dst] = V.x[src]; V.y[dst] = V.y[src]; V.hx[dst] = V.hx[src]; V.hy[dst] = V.hy[src];
}

function removeVehicles(t, k) {
  let i = V.n - 1;
  while (k > 0 && i >= 0) {
    if (V.type[i] === t) { moveVehicle(i, V.n - 1); V.n--; k--; }
    i--;
  }
}

function placeMany(t, need) {
  let ok = 0, streak = 0; const t0 = now();
  for (let k = 0; k < need; k++) {
    if (tryPlace(t)) { ok++; streak = 0; }
    else if (++streak >= PHYS.failStreak) break;
    if ((k & 127) === 0 && now() - t0 > PHYS.budgetMs) break;
  }
  return ok;
}

function resetRun() { run.events = 0; run.days = 0; }

function setCount(t, want) {
  want = Math.max(0, Math.floor(Number(want) || 0));
  let others = 0; for (let k = 0; k < nT; k++) if (k !== t) others += counts[k];
  want = Math.min(want, MAX_VEHICLES - others);
  const cur = counts[t];
  if (want > cur) {
    placed[t] += placeMany(t, want - cur);
  } else if (want < cur) {
    let rem = cur - want;
    rem -= Math.min(cur - placed[t], rem);
    if (rem > 0) { removeVehicles(t, rem); placed[t] -= rem; rebuildGrid(); }
  }
  counts[t] = want;
  updateRmax(); resetRun();
  state.dirty = true;
}

function applyCounts(arr) {
  for (let t = 0; t < nT; t++) if (arr[t] < counts[t]) setCount(t, arr[t]);
  for (let t = 0; t < nT; t++) if (arr[t] > counts[t]) setCount(t, arr[t]);
  syncTypeInputs();
}

function mixCounts(total) {
  const f = total / TODAY_TOTAL;
  return TYPES.map((t) => Math.round(t.count * f));
}

function replaceAll() {
  V.n = 0; placed.fill(0);
  for (let k = 0; k < dirtyCount; k++) G.head[dirtyCells[k]] = -1;
  dirtyCount = 0; RMAX = 0;
  for (let t = 0; t < nT; t++) if (counts[t] > 0 && RAD[t] > RMAX) RMAX = RAD[t];
  const order = TYPES.map((_, i) => i).sort((a, b) => FP[b] - FP[a]);
  for (const t of order) placed[t] = placeMany(t, counts[t]);
  updateRmax(); state.dirty = true;
}

let replaceTimer = 0;
function scheduleReplace() {
  if (typeof setTimeout !== 'function') return replaceAll();
  clearTimeout(replaceTimer);
  replaceTimer = setTimeout(replaceAll, 200);
}

const requestedTotal = () => { let s = 0; for (let t = 0; t < nT; t++) s += counts[t]; return s; };
const placedTotal = () => { let s = 0; for (let t = 0; t < nT; t++) s += placed[t]; return s; };

/* =====================================================================
 * 6. SIMULATION STEP
 * ===================================================================== */
function step(dt) {
  if (!(dt > 0)) { substep(0); return; }
  const nSub = Math.min(PHYS.maxSub, Math.max(1, Math.ceil(dt / PHYS.subDt)));
  const h = Math.min(dt / nSub, PHYS.subDt);
  for (let k = 0; k < nSub; k++) substep(h);
}

function substep(h) {
  const n = V.n, E = net.E;
  const { occ, spdF, len, u, v } = net;
  occ.fill(0);
  if (h > 0) rebuildGrid();
  let sumV = 0, sumF = 0, mv = 0, parkedN = 0, parkedFP = 0, blockedN = 0;

  for (let i = 0; i < n; i++) {
    const t = V.type[i], e = V.e[i];
    occ[e] += FP[t];
    if (PARKED[i]) {
      parkedN++; parkedFP += FP[t];
      if (h === 0) { pose(e, V.s[i], V.dir[i], 0, true, V.side[i], t); V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY; }
      continue;
    }
    const base = TV[t] * V.jit[i], sp = base * spdF[e];
    mv++; sumF += base;
    const s = V.s[i], dir = V.dir[i];

    if (h === 0) {
      pose(e, s, dir, V.lat[i], false, 0, t);
      V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY; sumV += sp;
      continue;
    }

    let ne = e, ns = s + dir * sp * h, nd = dir;
    const L = len[e];
    if (ns >= L) {
      let over = ns - L; const node = v[e], nx = pickNext(node, e);
      if (nx < 0) { nd = -1; ns = L - Math.min(over, L); }
      else {
        const Ln = len[nx]; over = Math.min(over, Ln);
        if (u[nx] === node) { nd = 1; ns = over; } else { nd = -1; ns = Ln - over; }
        ne = nx;
      }
    } else if (ns <= 0) {
      let over = -ns; const node = u[e], nx = pickNext(node, e);
      if (nx < 0) { nd = 1; ns = Math.min(over, L); }
      else {
        const Ln = len[nx]; over = Math.min(over, Ln);
        if (u[nx] === node) { nd = 1; ns = over; } else { nd = -1; ns = Ln - over; }
        ne = nx;
      }
    }
    pose(ne, ns, nd, V.lat[i], false, 0, t);
    if (!overlapsAny(PX, PY, PHX, PHY, t, i)) {
      V.e[i] = ne; V.s[i] = ns; V.dir[i] = nd; V.stuck[i] = 0;
      V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY;
      sumV += sp;
    } else {
      blockedN++;
      const st = (V.stuck[i] += h);
      if (st > PHYS.relaneAfter) V.lat[i] = Math.random();
      if (st > PHYS.reverseAfter) {
        pose(e, s, -dir, V.lat[i], false, 0, t);
        if (!overlapsAny(PX, PY, PHX, PHY, t, i)) {
          V.dir[i] = -dir; V.stuck[i] = 0; V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY;
        }
      }
    }
  }

  const jam = state.jam, Ae = net.Ae;
  let congArea = 0;
  for (let e = 0; e < E; e++) {
    const cov = occ[e] / Ae[e];
    net.cov[e] = cov;
    const r = cov / jam;
    spdF[e] = state.slow ? Math.max(0.03, 1 - r) : 1;
    net.bkt[e] = r >= 1 ? 6 : Math.floor(r * 6);
    if (r >= 0.8) congArea += Ae[e];
  }
  stats = { mv, parkedN, parkedFP, sumV, sumF, congArea, blockedN };
}

/* =====================================================================
 * 7. RENDERING
 * ===================================================================== */
const cv = $('cv'), ctx = cv.getContext('2d');
const view = { w: 800, h: 600, dpr: 1 };
const cam = { x: 0, y: 0, scale: 0.1 };

function resize() {
  const r = cv.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  view.w = Math.max(100, r.width); view.h = Math.max(100, r.height);
  cv.width = Math.floor(view.w * view.dpr); cv.height = Math.floor(view.h * view.dpr);
}

function fitView() {
  if (!net) return;
  const [x0, y0, x1, y1] = net.bounds;
  cam.x = (x0 + x1) / 2; cam.y = (y0 + y1) / 2;
  cam.scale = Math.min(view.w / (x1 - x0), view.h / (y1 - y0)) * 0.92;
}

function niceBar(scale) {
  const opts = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const m of opts) if (m * scale >= 80) return m;
  return opts[opts.length - 1];
}

function draw() {
  const { dpr } = view, cw = view.w, ch = view.h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, cw, ch);
  if (!net) return;
  const sc = cam.scale, cx = cam.x, cy = cam.y, hw = cw / 2, hh = ch / 2;
  const wx0 = cx - hw / sc - 40, wx1 = cx + hw / sc + 40, wy0 = cy - hh / sc - 40, wy1 = cy + hh / sc + 40;

  // ---- streets ---------------------------------------------------------
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  const passes = state.heat ? 7 : 1;
  const batches = new Map();

  for (let e = 0; e < net.E; e++) {
    if (net.bx1[e] < wx0 || net.bx0[e] > wx1 || net.by1[e] < wy0 || net.by0[e] > wy1) continue;
    const bkt = state.heat ? net.bkt[e] : 0;
    if (state.heat && bkt >= passes) continue;
    
    const lw = Math.max(0.7, net.ewS[e] * sc);
    const key = bkt + '_' + lw.toFixed(2);
    
    let batch = batches.get(key);
    if (!batch) { batch = { bkt, lw, edges: [] }; batches.set(key, batch); }
    batch.edges.push(e);
  }

  for (const batch of batches.values()) {
    ctx.strokeStyle = state.heat ? HEAT[batch.bkt] : '#2f3b49';
    ctx.lineWidth = batch.lw;
    ctx.beginPath();
    for (const e of batch.edges) {
      const o = net.off[e], end = net.off[e + 1];
      for (let k = o; k < end; k++) {
        const X = (net.px[k] - cx) * sc + hw, Y = hh - (net.py[k] - cy) * sc;
        if (k === o) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
    }
    ctx.stroke();
  }

  // ---- vehicles (Fixed true-to-scale dimensions regardless of area slider) ---
  const n = V.n; let visCount = 0;
  for (let i = 0; i < n; i++) {
    const X = (V.x[i] - cx) * sc + hw, Y = hh - (V.y[i] - cy) * sc;
    SX[i] = X; SY[i] = Y;
    const vis = X > -6 && X < cw + 6 && Y > -6 && Y < ch + 6 ? 1 : 0;
    VIS[i] = vis; visCount += vis;
  }
  const trueScale = sc >= 3 && visCount < 25000;
  const order = TYPES.map((_, i) => i).sort((a, b) => FP[b] - FP[a]);
  const passesP = state.parkShare > 0 ? [0, 1] : [0];

  for (const t of order) {
    const col = TYPES[t].color;
    for (const pk of passesP) {
      ctx.globalAlpha = pk ? 0.5 : 1;
      ctx.fillStyle = col;
      if (trueScale) {
        const L = TYPES[t].L, W = TYPES[t].W;
        for (let i = 0; i < n; i++) {
          if (!VIS[i] || V.type[i] !== t || PARKED[i] !== pk) continue;
          const a = dpr * sc * V.hx[i], b = dpr * sc * V.hy[i];
          ctx.setTransform(a, -b, b, a, dpr * SX[i], dpr * SY[i]);
          ctx.fillRect(-L / 2, -W / 2, L, W);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        const size = Math.max(state.dotPx, Math.sqrt(FP[t]) * sc), half = size / 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (!VIS[i] || V.type[i] !== t || PARKED[i] !== pk) continue;
          ctx.rect(SX[i] - half, SY[i] - half, size, size);
        }
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  // ---- collision flashes -----------------------------------------------
  const tNow = now();
  while (markers.length && tNow - markers[0].t > 2500) markers.shift();
  for (const m of markers) {
    const age = (tNow - m.t) / 2500, X = (m.x - cx) * sc + hw, Y = hh - (m.y - cy) * sc;
    if (X < -40 || X > cw + 40 || Y < -40 || Y > ch + 40) continue;
    ctx.globalAlpha = 1 - age; ctx.strokeStyle = '#ff3b30'; ctx.fillStyle = '#ff3b30'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X, Y, 7 + age * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(X, Y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ---- scale bar -------------------------------------------------------
  const m = niceBar(sc), px = m * sc;
  const bx = cw - 24 - px, by = ch - 22;
  ctx.fillStyle = '#e6edf3'; ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + px, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
  ctx.moveTo(bx + px, by - 4); ctx.lineTo(bx + px, by + 4); ctx.stroke();
  ctx.font = '12px system-ui,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(m >= 1000 ? (m / 1000) + ' km' : m + ' m', bx + px / 2, by - 8);
  ctx.textAlign = 'left';
  if (!trueScale) ctx.fillText('dots enlarged · zoom in for true scale', 12, 20 + (state.synthetic ? 56 : 0));
}

/* =====================================================================
 * 8. YEARS & COLLISIONS
 * ===================================================================== */
function groupIndex(t, yi) {
  const g = yearsCfg.type_group[TYPES[t].id] || 'other';
  return yearsCfg.fleet_index_vs_2024[g].values[yi];
}
const fleetForYearIdx = (yi) => TYPES.map((tp, t) => Math.round(tp.count * groupIndex(t, yi)));
const sumArr = (a) => a.reduce((p, q) => p + q, 0);

function yearStatusRank(yi) {
  let r = 0;
  for (const g of Object.values(yearsCfg.fleet_index_vs_2024)) {
    if (!g.status) continue;
    r = Math.max(r, STATUS_RANK[g.status[yi]] || 0);
  }
  return r;
}

function applyYear(year) {
  if (!yearsCfg) return;
  const yi = yearsCfg.years.indexOf(year);
  if (yi < 0) return;
  state.year = year; state.yearCustom = false;
  applyCounts(fleetForYearIdx(yi));
  if ($('scaleRange')) {
    $('scaleRange').value = Math.round(100 * requestedTotal() / TODAY_TOTAL);
    if ($('scaleOut')) $('scaleOut').textContent = $('scaleRange').value + ' %';
  }
  updateYearUI();
}

function markCustom() { if (!state.yearCustom) { state.yearCustom = true; updateYearUI(); } }

function updateYearUI() {
  if (!$('yearOut')) return;
  if (!yearsCfg) { if ($('yearStatus')) $('yearStatus').textContent = 'data/years.json not found: year slider disabled.'; return; }
  if ($('yearRange')) $('yearRange').value = state.year;
  $('yearOut').textContent = state.year + (state.yearCustom ? ' · edited' : '');
  const yi = yearsCfg.years.indexOf(state.year), r = yearStatusRank(yi);
  const key = ['baseline', 'nbs_shape', 'estimate', 'assumption'][r];
  if ($('yearStatus')) {
    $('yearStatus').textContent = (state.yearCustom ? 'Fleet edited by hand; collisions use the current fleet. ' : '') + STATUS_TXT[key];
    $('yearStatus').style.color = STATUS_COL[r];
  }
  if ($('yearFleet')) $('yearFleet').textContent = fmt(requestedTotal()) + ' vehicles';
}

const baseAccidents = () => {
  let police = COL.baseAcc;
  if (yearsCfg) { const r = yearsCfg.accidents.series.find((x) => x.year === yearsCfg.baseline.year); if (r) police = r.police; }
  return police * state.share;
};
const baseFleet = () => (yearsCfg ? yearsCfg.baseline.fleet : COL.baseFleet);
const expectedPerYear = (N, beta) => baseAccidents() * Math.pow(N / baseFleet(), beta);

function computeFit() {
  if (!yearsCfg) return null;
  const xs = [], ys = [];
  for (const y of yearsCfg.model.fit_years) {
    const yi = yearsCfg.years.indexOf(y), row = yearsCfg.accidents.series.find((r) => r.year === y);
    if (yi < 0 || !row) continue;
    xs.push(Math.log(sumArr(fleetForYearIdx(yi)))); ys.push(Math.log(row.police));
  }
  const n = xs.length; if (n < 3) return null;
  const mx = sumArr(xs) / n, my = sumArr(ys) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { beta: sxy / sxx, r2: (sxy * sxy) / (sxx * syy), n };
}

function poisson(mean) {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean); let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L && k < 50);
  return k - 1;
}

function spawnCollision() {
  if (!V.n) return;
  let best = -1, bc = -1;
  for (let k = 0; k < 4; k++) {
    const i = (Math.random() * V.n) | 0;
    if (PARKED[i]) continue;
    const c = net.cov[V.e[i]];
    if (c > bc) { bc = c; best = i; }
  }
  if (best < 0) return;
  markers.push({ x: V.x[best], y: V.y[best], t: now() });
  if (markers.length > 300) markers.shift();
  run.events++;
}

function tickCollisions(real) {
  if (!state.colOn) return;
  const perYear = expectedPerYear(requestedTotal(), state.beta);
  run.days += real / state.secPerDay;
  const k = poisson(perYear / 365 / state.secPerDay * real);
  for (let i = 0; i < k; i++) spawnCollision();
}

function updateCollisionPanel() {
  if (!$('colYr')) return;
  const N = requestedTotal(), b = state.beta;
  const A = expectedPerYear(N, b), A0 = baseAccidents();
  if ($('colN')) $('colN').textContent = fmt(N) + ' vehicles';
  $('colYr').textContent = fmt(A) + ' / year';
  if ($('colDay')) $('colDay').textContent = (A / 365).toFixed(1) + ' / day';
  if ($('colPer1k')) $('colPer1k').textContent = N ? (A / N * 1000).toFixed(1) : '–';
  const d = (A / A0 - 1) * 100;
  if ($('colDelta')) $('colDelta').textContent = (d >= 0 ? '+' : '') + d.toFixed(0) + ' % (fleet ' + (N / baseFleet() * 100 - 100 >= 0 ? '+' : '') + (N / baseFleet() * 100 - 100).toFixed(0) + ' %)';
  if ($('colBand')) $('colBand').textContent = [1, 1.5, 2].map((x) => 'β ' + x.toFixed(1) + ': ' + fmt(expectedPerYear(N, x))).join('   ·   ');
  let obs = '–';
  if (yearsCfg && !state.yearCustom) {
    const row = yearsCfg.accidents.series.find((r) => r.year === state.year);
    if (row) obs = fmt(row.police * state.share) + (row.status === 'police_full_year' ? '' : ' (estimate)');
  }
  if ($('colObs')) $('colObs').textContent = obs;
  const ev = run.events, dy = run.days;
  if ($('colRun')) $('colRun').textContent = ev + ' in ' + dy.toFixed(1) + ' sim. days' +
    (dy >= 1 ? '  →  ' + fmt(ev / dy * 365) + ' / yr (±' + fmt(Math.sqrt(Math.max(ev, 1)) / dy * 365) + ')' : '');
  if ($('betaOut')) $('betaOut').textContent = b.toFixed(2);
  if (fit && $('betaFit')) $('betaFit').textContent = 'Fit 2021–25: β ≈ ' + fit.beta.toFixed(2);
}

/* =====================================================================
 * 9. UI BINDINGS
 * ===================================================================== */
const fmt = (x) => Math.round(x).toLocaleString('en-US');

function buildTypeRows() {
  const box = $('types'); if (!box) return;
  box.innerHTML = '';
  TYPES.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'trow';
    row.innerHTML = `<span class="dot" style="background:${t.color}"></span><label>${t.name}</label>
      <input type="number" min="0" step="1" class="cnum">
      <input type="range" class="crange" min="0" max="${t.max}" step="${t.step || 1}">`;
    const num = row.querySelector('.cnum'), rng = row.querySelector('.crange');
    num.addEventListener('input', () => { setCount(i, num.value); rng.value = counts[i]; markCustom(); });
    num.addEventListener('change', () => { num.value = counts[i]; });
    rng.addEventListener('input', () => { setCount(i, rng.value); num.value = counts[i]; markCustom(); });
    row._num = num; row._rng = rng;
    box.appendChild(row);
  });
}

function syncTypeInputs() {
  const box = $('types'); if (!box) return;
  const rows = box.children;
  for (let i = 0; i < rows.length; i++) { rows[i]._num.value = counts[i]; rows[i]._rng.value = counts[i]; }
}

function buildDims() {
  const tb = $('dims'); if (!tb) return;
  tb.innerHTML = '<tr><th>Type</th><th>L (m)</th><th>W (m)</th><th>km/h</th></tr>';
  TYPES.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t.name}</td>
      <td><input type="number" step="0.1" min="0.3" value="${t.L}" data-k="L"></td>
      <td><input type="number" step="0.1" min="0.3" value="${t.W}" data-k="W"></td>
      <td><input type="number" step="1" min="1" value="${(t.v * 3.6).toFixed(0)}" data-k="v"></td>`;
    tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const val = parseFloat(inp.value); if (!(val > 0)) return;
      const k = inp.dataset.k;
      if (k === 'v') t.v = val / 3.6; else t[k] = val;
      refreshType(i); updateRmax(); state.dirty = true;
      if (k !== 'v' && initialised) scheduleReplace();
    }));
    tb.appendChild(tr);
  });
}

function bindUI() {
  const ar = $('areaRange');
  if (ar) {
    ar.min = AREA.min; ar.max = AREA.max; ar.step = AREA.step; ar.value = state.areaKm2;
    const setArea = (v) => { state.areaKm2 = Math.min(AREA.max, Math.max(AREA.min, v)); ar.value = state.areaKm2;
      if ($('areaOut'))$('areaOut').textContent = state.areaKm2.toFixed(3) + ' km²'; applyRoadArea(); };
    ar.addEventListener('input', () => setArea(parseFloat(ar.value)));
    if ($('areaOsmnx'))$('areaOsmnx').addEventListener('click', () => setArea(AREA.osmnx));
    if ($('areaReport'))$('areaReport').addEventListener('click', () => setArea(AREA.report));
    if ($('areaOut'))$('areaOut').textContent = state.areaKm2.toFixed(3) + ' km²';
  }

  const pb = $('presets');
  if (pb) {
    PRESETS.forEach((p) => {
      const b = document.createElement('button'); b.textContent = p.label;
      b.addEventListener('click', () => {
        applyCounts(p.proposed ? TYPES.map((t) => t.proposed) : mixCounts(p.total));
        const pct = p.proposed ? Math.round(100 * 89413 / TODAY_TOTAL) : Math.round(100 * p.total / TODAY_TOTAL);
        if ($('scaleRange'))$('scaleRange').value = pct;
        if ($('scaleOut'))$('scaleOut').textContent = pct + ' %';
        markCustom();
      });
      pb.appendChild(b);
    });
  }

  if ($('scaleRange')) {$('scaleRange').addEventListener('input', (ev) => {
      const pct = parseFloat(ev.target.value); if ($('scaleOut'))$('scaleOut').textContent = pct + ' %';
      applyCounts(mixCounts(TODAY_TOTAL * pct / 100)); markCustom();
    });
  }

  if ($('yearRange'))$('yearRange').addEventListener('input', (ev) => applyYear(parseInt(ev.target.value, 10)));
  
  const setBeta = (b) => {
    state.beta = Math.min(2.5, Math.max(1, b));
    if ($('betaRange'))$('betaRange').value = state.beta;
    updateCollisionPanel();
  };

  if ($('betaRange'))$('betaRange').addEventListener('input', (ev) => setBeta(parseFloat(ev.target.value)));
  if ($('beta1'))$('beta1').addEventListener('click', () => setBeta(1));
  if ($('beta15'))$('beta15').addEventListener('click', () => setBeta(1.5));
  if ($('beta2'))$('beta2').addEventListener('click', () => setBeta(2));
  if ($('betaFit'))$('betaFit').addEventListener('click', () => { if (fit) setBeta(fit.beta); });
  if ($('shareNum'))$('shareNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0 && v <= 100) { state.share = v / 100; updateCollisionPanel(); } });
  if ($('colChk'))$('colChk').addEventListener('change', (ev) => { state.colOn = ev.target.checked; });
  if ($('secDayRange'))$('secDayRange').addEventListener('input', (ev) => { state.secPerDay = parseFloat(ev.target.value); if ($('secDayOut'))$('secDayOut').textContent = state.secPerDay + ' s'; });
  if ($('colReset'))$('colReset').addEventListener('click', () => { resetRun(); markers.length = 0; });

  if ($('parkRange'))$('parkRange').addEventListener('input', (ev) => { state.parkShare = ev.target.value / 100; if ($('parkOut'))$('parkOut').textContent = ev.target.value + ' %'; state.dirty = true; scheduleReplace(); });
  if ($('stripNum'))$('stripNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0) { state.parkStrip = v; state.dirty = true; scheduleReplace(); } });
  if ($('jamRange'))$('jamRange').addEventListener('input', (ev) => { state.jam = ev.target.value / 100; if ($('jamOut'))$('jamOut').textContent = ev.target.value + ' %'; state.dirty = true; });
  if ($('speedSel'))$('speedSel').addEventListener('change', (ev) => { state.simSpeed = parseFloat(ev.target.value); });
  if ($('pauseBtn'))$('pauseBtn').addEventListener('click', (ev) => { state.paused = !state.paused; ev.target.textContent = state.paused ? 'Resume' : 'Pause'; });
  if ($('dotRange'))$('dotRange').addEventListener('input', (ev) => { state.dotPx = parseFloat(ev.target.value); if ($('dotOut'))$('dotOut').textContent = state.dotPx.toFixed(1) + ' px'; });
  if ($('heatChk'))$('heatChk').addEventListener('change', (ev) => { state.heat = ev.target.checked; });
  if ($('slowChk'))$('slowChk').addEventListener('change', (ev) => { state.slow = ev.target.checked; state.dirty = true; });

  const zoomAt = (mx, my, f) => {
    const wx = (mx - view.w / 2) / cam.scale + cam.x, wy = cam.y - (my - view.h / 2) / cam.scale;
    cam.scale = Math.min(60, Math.max(0.02, cam.scale * f));
    cam.x = wx - (mx - view.w / 2) / cam.scale; cam.y = wy + (my - view.h / 2) / cam.scale;
  };
  if ($('zin'))$('zin').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1.5));
  if ($('zout'))$('zout').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1 / 1.5));
  if ($('zfit'))$('zfit').addEventListener('click', fitView);
  cv.addEventListener('dblclick', fitView);
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
  }, { passive: false });

  const ptrs = new Map(); let lastDist = 0;
  cv.addEventListener('pointerdown', (ev) => { cv.setPointerCapture(ev.pointerId); ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); lastDist = 0; });
  cv.addEventListener('pointerup', (ev) => ptrs.delete(ev.pointerId));
  cv.addEventListener('pointercancel', (ev) => ptrs.delete(ev.pointerId));
  cv.addEventListener('pointermove', (ev) => {
    const p = ptrs.get(ev.pointerId); if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.x = ev.clientX; p.y = ev.clientY;
    if (ptrs.size === 1) { cam.x -= dx / cam.scale; cam.y += dy / cam.scale; }
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDist > 0) {
        const r = cv.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / lastDist);
      }
      lastDist = d;
    }
  });
}

let lastStatsT = 0;
function updateStats() {
  const areaM2 = state.areaKm2 * 1e6;
  let foot = 0;
  for (let t = 0; t < nT; t++) foot += placed[t] * FP[t];
  const total = placedTotal(), req = requestedTotal();
  const pct = foot / areaM2;
  const jam = state.jam;

  if ($('sArea'))$('sArea').textContent = state.areaKm2.toFixed(3) + ' km²';
  if ($('sFoot'))$('sFoot').textContent = (foot / 1e6).toFixed(3) + ' km²  (' + fmt(foot) + ' m²)';
  if ($('sPct'))$('sPct').textContent = (pct * 100).toFixed(1) + ' %';
  if ($('sParkFoot'))$('sParkFoot').textContent = (stats.parkedFP / areaM2 * 100).toFixed(1) + ' %';
  if ($('sVeh'))$('sVeh').textContent = fmt(total) + '  (' + fmt(stats.mv) + ' / ' + fmt(stats.parkedN) + ')';

  if ($('sPlaced')) {
    const unfit = req - total;
    $('sPlaced').textContent = unfit > 0 ? fmt(total) + ' of ' + fmt(req) + ' · ' + fmt(unfit) + ' do not fit' : fmt(total) + ' of ' + fmt(req);
    $('sPlaced').style.color = unfit > 0 ? '#f85149' : '';
  }
  if ($('sBlocked'))$('sBlocked').textContent = stats.mv ? (stats.blockedN / stats.mv * 100).toFixed(1) + ' % waiting' : '–';
  
  const kmh = stats.mv ? stats.sumV / stats.mv * 3.6 : 0;
  const rel = stats.sumF ? stats.sumV / stats.sumF * 100 : 100;
  if ($('sSpeed'))$('sSpeed').textContent = stats.mv ? kmh.toFixed(1) + ' km/h  (' + rel.toFixed(0) + ' % of free-flow)' : '–';
  if ($('sCong'))$('sCong').textContent = (stats.congArea / areaM2 * 100).toFixed(1) + ' %';
  
  const meanFP = total ? foot / total : 0;
  if ($('sCeil'))$('sCeil').textContent = meanFP ? '≈ ' + fmt(jam * areaM2 / meanFP) + ' vehicles' : '–';
  
  if ($('barFill')) {
    const fill = $('barFill');
    fill.style.width = Math.min(100, pct * 100) + '%';
    const ratio = pct / jam;
    fill.style.background = ratio < 0.6 ? '#3fb950' : ratio < 1 ? '#e3a008' : '#f85149';
  }
  if ($('barMark'))$('barMark').style.left = (jam * 100) + '%';
  if ($('barMarkLbl'))$('barMarkLbl').textContent = 'packing limit ' + Math.round(jam * 100) + ' %';
  if ($('yearFleet'))$('yearFleet').textContent = fmt(req) + ' vehicles';
  updateCollisionPanel();
}

/* =====================================================================
 * 10. MAIN LOOP & INIT
 * ===================================================================== */
let lastT = 0;
function frame(t) {
  const real = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
  if (net) {
    if (!state.paused) { step(Math.min(1.0, real * state.simSpeed)); tickCollisions(real); }
    else if (state.dirty) step(0);
    state.dirty = false;
    draw();
    if (t - lastStatsT > 250) { lastStatsT = t; updateStats(); }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
}

async function init() {
  buildTypeRows(); buildDims(); bindUI();
  resize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { resize(); }).observe(cv.parentElement);
  const [rawNet, years] = await Promise.all([loadJson('data/network.json'), loadJson('data/years.json')]);
  const synthetic = !rawNet;
  state.synthetic = synthetic;
  net = prepareNetwork(rawNet || makeSyntheticNetwork());
  buildGrid();
  if (synthetic) {
    const b = $('banner'); if (b) {
      b.style.display = 'block';
      b.innerHTML = 'Showing a <b>placeholder network</b> because <code>data/network.json</code> was not found. ' +
        'Run <code>python tools/export_network.py</code> to build the real Greater Malé streets.';
    }
  }
  yearsCfg = years;
  if (yearsCfg) {
    fit = computeFit();
    const yr = $('yearRange');
    if (yr) {
      yr.min = yearsCfg.years[0]; yr.max = yearsCfg.years[yearsCfg.years.length - 1]; yr.step = 1;
    }
    state.year = yearsCfg.baseline.year;
    const sh = yearsCfg.accidents.greater_male_share;
    if (sh > 0) { state.share = sh; if ($('shareNum'))$('shareNum').value = Math.round(sh * 100); }
    state.beta = yearsCfg.model.beta_default || COL.beta;
    if ($('betaRange'))$('betaRange').value = state.beta;
  } else {
    if ($('yearRange'))$('yearRange').disabled = true;
  }
  applyRoadArea();
  
  // Initialize to 60% capacity
  applyCounts(mixCounts(TODAY_TOTAL * 0.6));
  if ($('scaleRange'))$('scaleRange').value = 60;
  if ($('scaleOut'))$('scaleOut').textContent = '60 %';
  state.yearCustom = true;
  
  initialised = true;
  updateYearUI();
  fitView();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
}

window.TrafficSim = { state, counts, placed, V, TYPES, PHYS, step, draw, updateStats, setCount, applyCounts, mixCounts,
  replaceAll, applyYear, expectedPerYear, spawnCollision, run, markers, overlapsAny, rectsOverlap,
  get net() { return net; }, get stats() { return stats; }, get years() { return yearsCfg; }, get fit() { return fit; },
  fleetForYearIdx, fitView };
init();
})();
