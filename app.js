/* Greater Malé road capacity simulator
 * Plain JS, no build step. Loads data/network.json (made by tools/export_network.py);
 * falls back to a small placeholder network if that file is missing.
 */
(() => {
'use strict';

/* =====================================================================
 * 1. CONFIG - edit these to change defaults
 * ===================================================================== */
const AREA = { min: 0.80, max: 1.00, step: 0.001, osmnx: 0.894, report: 0.902 };
const DEFAULTS = { parkShare: 0, parkStrip: 2.3, jam: 0.50, simSpeed: 10, dotPx: 2 };
const MAX_VEHICLES = 400000;
const TODAY_TOTAL = 119093; // Table 3

// count = Table 3 today; proposed = Table 51 proposal (grouped to the types below)
// L, W = footprint in metres; v = free-flow speed in m/s (~ 6-8 m/s = 22-29 km/h)
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
// "Other" = battery cars, ambulances, tricycles, minivans, mini trucks, e-scooters + Table 3 "Others" (1,109).
// Table 51 proposal for "other" = those + 196 others + 1,305 industrial vehicles = 1,613 (total 89,413).

const PRESETS = [
  { label: 'Today · 119,093',            total: 119093 },
  { label: 'Roadworthy only · 100,175',  total: 100175 },
  { label: 'Report proposal · 89,413',   proposed: true },
  { label: 'Population-based · 81,138',  total: 81138 },
  { label: 'Road-space-based · 51,905',  total: 51905 },
  { label: 'Empty',                      total: 0 },
];

const HEAT = ['#232c38', '#2b4a45', '#3f6b3a', '#7b7a25', '#a8691f', '#c2411f', '#d71f2e'];

/* =====================================================================
 * 2. STATE
 * ===================================================================== */
const $ = (id) => document.getElementById(id);
const nT = TYPES.length;
const counts = new Int32Array(nT);
const FP = new Float32Array(nT);   // footprint m2 per type
const TV = new Float32Array(nT);   // free-flow speed per type
const state = {
  areaKm2: AREA.osmnx, parkShare: DEFAULTS.parkShare / 100, parkStrip: DEFAULTS.parkStrip,
  jam: DEFAULTS.jam, simSpeed: DEFAULTS.simSpeed, dotPx: DEFAULTS.dotPx,
  paused: false, heat: true, slow: false, dirty: true, synthetic: false,
};
TYPES.forEach((t, i) => { FP[i] = t.L * t.W; TV[i] = t.v; });

let net = null;               // prepared network (typed arrays)
const V = {                   // vehicle pool (structure of arrays)
  n: 0,
  e: new Int32Array(MAX_VEHICLES), s: new Float32Array(MAX_VEHICLES), dir: new Int8Array(MAX_VEHICLES),
  jit: new Float32Array(MAX_VEHICLES), type: new Uint8Array(MAX_VEHICLES), lat: new Float32Array(MAX_VEHICLES),
  park: new Float32Array(MAX_VEHICLES), side: new Int8Array(MAX_VEHICLES),
  x: new Float32Array(MAX_VEHICLES), y: new Float32Array(MAX_VEHICLES),
  hx: new Float32Array(MAX_VEHICLES), hy: new Float32Array(MAX_VEHICLES),
};
const PARKED = new Uint8Array(MAX_VEHICLES);
const SX = new Float32Array(MAX_VEHICLES), SY = new Float32Array(MAX_VEHICLES), VIS = new Uint8Array(MAX_VEHICLES);
let stats = { mv: 0, parkedN: 0, parkedFP: 0, sumV: 0, sumF: 0, congArea: 0 };

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
  grid(0, 0, 1700, 840, 85, 70, 11, 6, 4);          // "Malé"
  grid(3300, 2900, 4100, 6300, 100, 136, 12, 7, 4); // "Hulhumalé"
  const bridge = [[1700, 420], [2300, 1000], [2700, 1800], [3000, 2400], [3300, 2900]];
  for (let i = 0; i < bridge.length - 1; i++) seg(...bridge[i], ...bridge[i + 1], 14);
  seg(2700, 1800, 2550, 2300, 10); seg(2550, 2300, 3000, 2400, 10); // airport loop
  return { meta: { synthetic: true }, nodes, edges };
}

async function loadNetwork() {
  try {
    const r = await fetch('data/network.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return { raw: await r.json(), synthetic: false };
  } catch (err) {
    return { raw: makeSyntheticNetwork(), synthetic: true };
  }
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
  // overlap correction: union area of the street polygons vs. sum(length x width)
  const union = raw.meta && raw.meta.area_m2 ? raw.meta.area_m2 : sumA;
  n.baseUnion = union;
  n.kappa = union / sumA;
  n.totalWeight = sumA;
  // adjacency (CSR)
  const deg = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) { deg[n.u[i] + 1]++; deg[n.v[i] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  n.adjOff = deg.slice();
  n.adjE = new Int32Array(deg[N]);
  const fill = deg.slice(0, N);
  for (let i = 0; i < E; i++) { n.adjE[fill[n.u[i]]++] = i; n.adjE[fill[n.v[i]]++] = i; }
  // per-frame arrays
  n.occ = new Float32Array(E); n.cov = new Float32Array(E); n.spdF = new Float32Array(E).fill(1);
  n.bkt = new Uint8Array(E);
  return n;
}

/** Recompute drawn widths and effective areas for the chosen road area (km2). */
function applyRoadArea() {
  const scale = (state.areaKm2 * 1e6) / net.baseUnion;
  net.widthScale = scale;
  for (let i = 0; i < net.E; i++) {
    net.ewS[i] = net.w0[i] * scale;
    net.Ae[i] = net.len[i] * net.ewS[i] * net.kappa; // effective area share of this street
  }
  state.dirty = true;
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
  if (tot <= 0) return -1; // dead end
  let r = Math.random() * tot, last = -1;
  for (let k = a; k < b; k++) {
    const ee = net.adjE[k]; if (ee === from) continue;
    last = ee; r -= net.w0[ee]; if (r <= 0) return ee;
  }
  return last;
}

/* =====================================================================
 * 4. VEHICLES
 * ===================================================================== */
function addVehicle(t) {
  const i = V.n++;
  const e = sampleEdge();
  V.e[i] = e; V.s[i] = Math.random() * net.len[e];
  V.dir[i] = Math.random() < 0.5 ? 1 : -1;
  V.jit[i] = 0.8 + 0.4 * Math.random();
  V.type[i] = t; V.lat[i] = Math.random(); V.park[i] = Math.random();
  V.side[i] = Math.random() < 0.5 ? 1 : -1;
}

function moveVehicle(dst, src) {
  V.e[dst] = V.e[src]; V.s[dst] = V.s[src]; V.dir[dst] = V.dir[src]; V.jit[dst] = V.jit[src];
  V.type[dst] = V.type[src]; V.lat[dst] = V.lat[src]; V.park[dst] = V.park[src]; V.side[dst] = V.side[src];
  V.x[dst] = V.x[src]; V.y[dst] = V.y[src]; V.hx[dst] = V.hx[src]; V.hy[dst] = V.hy[src];
}

function removeVehicles(t, k) {
  let i = V.n - 1;
  while (k > 0 && i >= 0) {
    if (V.type[i] === t) { moveVehicle(i, V.n - 1); V.n--; k--; }
    i--;
  }
}

function setCount(t, want) {
  want = Math.max(0, Math.floor(Number(want) || 0));
  const others = V.n - counts[t];
  want = Math.min(want, MAX_VEHICLES - others);
  const diff = want - counts[t];
  if (diff > 0) for (let k = 0; k < diff; k++) addVehicle(t);
  else if (diff < 0) removeVehicles(t, -diff);
  counts[t] = want;
  state.dirty = true;
}

function applyCounts(arr) {
  for (let t = 0; t < nT; t++) if (arr[t] < counts[t]) setCount(t, arr[t]); // shrink first
  for (let t = 0; t < nT; t++) if (arr[t] > counts[t]) setCount(t, arr[t]);
  syncTypeInputs();
}

function mixCounts(total) {
  const f = total / TODAY_TOTAL;
  return TYPES.map((t) => Math.round(t.count * f));
}

/* =====================================================================
 * 5. SIMULATION STEP
 * ===================================================================== */
function step(dt) {
  const n = V.n, E = net.E;
  const { occ, spdF, len, u, v, off, cum, px, py, ewS } = net;
  occ.fill(0);
  const ps = state.parkShare, strip = state.parkStrip, parkOn = ps > 0;
  let sumV = 0, sumF = 0, mv = 0, parkedN = 0, parkedFP = 0;

  for (let i = 0; i < n; i++) {
    const t = V.type[i];
    let e = V.e[i], s = V.s[i], dir = V.dir[i];
    occ[e] += FP[t];
    const parked = V.park[i] < ps;
    PARKED[i] = parked ? 1 : 0;

    if (parked) { parkedN++; parkedFP += FP[t]; }
    else {
      const base = TV[t] * V.jit[i];
      const sp = base * spdF[e];
      sumV += sp; sumF += base; mv++;
      if (dt > 0) {
        s += dir * sp * dt;
        const L = len[e];
        if (s >= L) {                               // leaves through the v end
          let over = s - L; const node = v[e], nx = pickNext(node, e);
          if (nx < 0) { dir = -1; s = L - Math.min(over, L); }
          else {
            const Ln = len[nx]; over = Math.min(over, Ln);
            if (u[nx] === node) { dir = 1; s = over; } else { dir = -1; s = Ln - over; }
            e = nx;
          }
        } else if (s <= 0) {                        // leaves through the u end
          let over = -s; const node = u[e], nx = pickNext(node, e);
          if (nx < 0) { dir = 1; s = Math.min(over, L); }
          else {
            const Ln = len[nx]; over = Math.min(over, Ln);
            if (u[nx] === node) { dir = 1; s = over; } else { dir = -1; s = Ln - over; }
            e = nx;
          }
        }
        V.e[i] = e; V.s[i] = s; V.dir[i] = dir;
      }
    }

    // ---- world position & heading --------------------------------------
    const o = off[e], last = off[e + 1] - 1;
    let k = o;
    while (k < last - 1 && cum[k + 1] < s) k++;
    const x0 = px[k], y0 = py[k];
    const sl = cum[k + 1] - cum[k];
    let dx = 1, dy = 0, tt = 0;
    if (sl > 1e-6) { dx = (px[k + 1] - x0) / sl; dy = (py[k + 1] - y0) / sl; tt = s - cum[k]; }
    const W = ewS[e];
    let latM;
    if (parked) latM = V.side[i] * Math.max(0, W * 0.5 - strip * 0.5);
    else latM = dir * V.lat[i] * Math.max(0.4, W * 0.5 - (parkOn ? strip : 0)); // drive on the left
    V.x[i] = x0 + dx * tt - dy * latM;
    V.y[i] = y0 + dy * tt + dx * latM;
    V.hx[i] = dir * dx; V.hy[i] = dir * dy;
  }

  // ---- per-street coverage -> speed factor & heat bucket ---------------
  const jam = state.jam, Ae = net.Ae;
  let congArea = 0;
  for (let e = 0; e < E; e++) {
    const cov = occ[e] / Ae[e];
    net.cov[e] = cov;
    const r = cov / jam;
    spdF[e] = state.slow ? Math.max(0.03, 1 - r) : 1; // slowdown is opt-in: it makes vehicles bunch up
    net.bkt[e] = r >= 1 ? 6 : Math.floor(r * 6);
    if (r >= 0.8) congArea += Ae[e];
  }
  stats = { mv, parkedN, parkedFP, sumV, sumF, congArea };
}

/* =====================================================================
 * 6. RENDERING
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
  for (let b = 0; b < passes; b++) {
    ctx.strokeStyle = state.heat ? HEAT[b] : '#2f3b49';
    for (let e = 0; e < net.E; e++) {
      if (state.heat && net.bkt[e] !== b) continue;
      if (net.bx1[e] < wx0 || net.bx0[e] > wx1 || net.by1[e] < wy0 || net.by0[e] > wy1) continue;
      ctx.lineWidth = Math.max(0.7, net.ewS[e] * sc);
      ctx.beginPath();
      const o = net.off[e], end = net.off[e + 1];
      for (let k = o; k < end; k++) {
        const X = (net.px[k] - cx) * sc + hw, Y = hh - (net.py[k] - cy) * sc;
        if (k === o) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
  }

  // ---- vehicles --------------------------------------------------------
  const n = V.n; let visCount = 0;
  for (let i = 0; i < n; i++) {
    const X = (V.x[i] - cx) * sc + hw, Y = hh - (V.y[i] - cy) * sc;
    SX[i] = X; SY[i] = Y;
    const vis = X > -6 && X < cw + 6 && Y > -6 && Y < ch + 6 ? 1 : 0;
    VIS[i] = vis; visCount += vis;
  }
  const trueScale = sc >= 3 && visCount < 25000;
  const order = TYPES.map((_, i) => i).sort((a, b) => FP[b] - FP[a]); // big first, small on top
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
        for (let i = 0; i < n; i++) {
          if (!VIS[i] || V.type[i] !== t || PARKED[i] !== pk) continue;
          ctx.fillRect(SX[i] - half, SY[i] - half, size, size);
        }
      }
    }
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
 * 7. UI
 * ===================================================================== */
const fmt = (x) => Math.round(x).toLocaleString('en-US');

function buildTypeRows() {
  const box = $('types'); box.innerHTML = '';
  TYPES.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'trow';
    row.innerHTML = `<span class="dot" style="background:${t.color}"></span><label>${t.name}</label>
      <input type="number" min="0" step="1" class="cnum">
      <input type="range" class="crange" min="0" max="${t.max}" step="${t.step || 1}">`;
    const num = row.querySelector('.cnum'), rng = row.querySelector('.crange');
    num.addEventListener('input', () => { setCount(i, num.value); rng.value = counts[i]; });
    num.addEventListener('change', () => { num.value = counts[i]; });
    rng.addEventListener('input', () => { setCount(i, rng.value); num.value = counts[i]; });
    row._num = num; row._rng = rng;
    box.appendChild(row);
  });
}

function syncTypeInputs() {
  const rows = $('types').children;
  for (let i = 0; i < rows.length; i++) { rows[i]._num.value = counts[i]; rows[i]._rng.value = counts[i]; }
}

function buildDims() {
  const tb = $('dims');
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
      if (k === 'v') { t.v = val / 3.6; TV[i] = t.v; } else { t[k] = val; FP[i] = t.L * t.W; }
      state.dirty = true;
    }));
    tb.appendChild(tr);
  });
}

function bindUI() {
  // road area
  const ar = $('areaRange');
  ar.min = AREA.min; ar.max = AREA.max; ar.step = AREA.step; ar.value = state.areaKm2;
  const setArea = (v) => { state.areaKm2 = Math.min(AREA.max, Math.max(AREA.min, v)); ar.value = state.areaKm2;
    $('areaOut').textContent = state.areaKm2.toFixed(3) + ' km²'; applyRoadArea(); };
  ar.addEventListener('input', () => setArea(parseFloat(ar.value)));
  $('areaOsmnx').addEventListener('click', () => setArea(AREA.osmnx));
  $('areaReport').addEventListener('click', () => setArea(AREA.report));
  $('areaOut').textContent = state.areaKm2.toFixed(3) + ' km²';

  // presets
  const pb = $('presets');
  PRESETS.forEach((p) => {
    const b = document.createElement('button'); b.textContent = p.label;
    b.addEventListener('click', () => {
      applyCounts(p.proposed ? TYPES.map((t) => t.proposed) : mixCounts(p.total));
      const pct = p.proposed ? Math.round(100 * 89413 / TODAY_TOTAL) : Math.round(100 * p.total / TODAY_TOTAL);
      $('scaleRange').value = pct; $('scaleOut').textContent = pct + ' %';
    });
    pb.appendChild(b);
  });
  $('scaleRange').addEventListener('input', (ev) => {
    const pct = parseFloat(ev.target.value); $('scaleOut').textContent = pct + ' %';
    applyCounts(mixCounts(TODAY_TOTAL * pct / 100));
  });

  // parking & movement
  $('parkRange').addEventListener('input', (ev) => { state.parkShare = ev.target.value / 100; $('parkOut').textContent = ev.target.value + ' %'; state.dirty = true; });
  $('stripNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0) { state.parkStrip = v; state.dirty = true; } });
  $('jamRange').addEventListener('input', (ev) => { state.jam = ev.target.value / 100; $('jamOut').textContent = ev.target.value + ' %'; state.dirty = true; });
  $('speedSel').addEventListener('change', (ev) => { state.simSpeed = parseFloat(ev.target.value); });
  $('pauseBtn').addEventListener('click', (ev) => { state.paused = !state.paused; ev.target.textContent = state.paused ? 'Resume' : 'Pause'; });
  $('dotRange').addEventListener('input', (ev) => { state.dotPx = parseFloat(ev.target.value); $('dotOut').textContent = state.dotPx.toFixed(1) + ' px'; });
  $('heatChk').addEventListener('change', (ev) => { state.heat = ev.target.checked; });
  $('slowChk').addEventListener('change', (ev) => { state.slow = ev.target.checked; state.dirty = true; });

  // camera
  const zoomAt = (mx, my, f) => {
    const wx = (mx - view.w / 2) / cam.scale + cam.x, wy = cam.y - (my - view.h / 2) / cam.scale;
    cam.scale = Math.min(60, Math.max(0.02, cam.scale * f));
    cam.x = wx - (mx - view.w / 2) / cam.scale; cam.y = wy + (my - view.h / 2) / cam.scale;
  };
  $('zin').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1.5));
  $('zout').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1 / 1.5));
  $('zfit').addEventListener('click', fitView);
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
  let total = 0, foot = 0;
  for (let t = 0; t < nT; t++) { total += counts[t]; foot += counts[t] * FP[t]; }
  const pct = foot / areaM2;                 // fraction
  const jam = state.jam;
  $('sArea').textContent = state.areaKm2.toFixed(3) + ' km²';
  $('sFoot').textContent = (foot / 1e6).toFixed(3) + ' km²  (' + fmt(foot) + ' m²)';
  $('sPct').textContent = (pct * 100).toFixed(1) + ' %';
  $('sParkFoot').textContent = (stats.parkedFP / areaM2 * 100).toFixed(1) + ' %';
  $('sVeh').textContent = fmt(total) + '  (' + fmt(stats.mv) + ' / ' + fmt(stats.parkedN) + ')';
  const kmh = stats.mv ? stats.sumV / stats.mv * 3.6 : 0;
  const rel = stats.sumF ? stats.sumV / stats.sumF * 100 : 100;
  $('sSpeed').textContent = stats.mv ? kmh.toFixed(1) + ' km/h  (' + rel.toFixed(0) + ' % of free-flow)' : '–';
  $('sCong').textContent = (stats.congArea / areaM2 * 100).toFixed(1) + ' %';
  const meanFP = total ? foot / total : 0;
  $('sCeil').textContent = meanFP ? '≈ ' + fmt(jam * areaM2 / meanFP) + ' vehicles' : '–';
  const fill = $('barFill');
  fill.style.width = Math.min(100, pct * 100) + '%';
  const ratio = pct / jam;
  fill.style.background = ratio < 0.6 ? '#3fb950' : ratio < 1 ? '#e3a008' : '#f85149';
  $('barMark').style.left = (jam * 100) + '%';
  $('barMarkLbl').textContent = 'packing limit ' + Math.round(jam * 100) + ' %';
}

/* =====================================================================
 * 8. MAIN LOOP
 * ===================================================================== */
let lastT = 0;
function frame(now) {
  const real = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
  if (net) {
    if (!state.paused) step(Math.min(1.0, real * state.simSpeed));
    else if (state.dirty) step(0);
    state.dirty = false;
    draw();
    if (now - lastStatsT > 250) { lastStatsT = now; updateStats(); }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
}

async function init() {
  buildTypeRows(); buildDims(); bindUI();
  resize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { resize(); }).observe(cv.parentElement);
  const { raw, synthetic } = await loadNetwork();
  state.synthetic = synthetic;
  net = prepareNetwork(raw);
  if (synthetic) {
    const b = $('banner'); b.style.display = 'block';
    b.innerHTML = 'Showing a <b>placeholder network</b> because <code>data/network.json</code> was not found. ' +
      'Run <code>python tools/export_network.py</code> to build the real Greater Malé streets. ' +
      '(Opening index.html straight from disk also blocks loading — use <code>python -m http.server</code>.)';
  }
  applyRoadArea();
  applyCounts(TYPES.map((t) => t.count));
  fitView();
  requestAnimationFrame(frame);
}

window.TrafficSim = { state, counts, V, TYPES, step, draw, updateStats, setCount, applyCounts, mixCounts,
  get net() { return net; }, get stats() { return stats; }, fitView };
init();
})();
