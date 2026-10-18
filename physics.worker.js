/* Greater Malé Traffic Simulator - Background Physics Worker */
'use strict';

let net = null;
let G = null;
const MAX_VEHICLES = 400000;
let nT = 0;

const TYPES = [
  { id: 'moto',    L: 2.0, W: 0.8, v: 7.5, max: 200000 },
  { id: 'car',     L: 4.4, W: 1.8, v: 6.5, max: 20000 },
  { id: 'pickup',  L: 5.2, W: 1.9, v: 6.0, max: 6000 },
  { id: 'scooter', L: 1.8, W: 0.7, v: 5.0, max: 6000 },
  { id: 'van',     L: 4.8, W: 1.9, v: 6.0, max: 6000 },
  { id: 'truck',   L: 7.0, W: 2.3, v: 5.0, max: 4000 },
  { id: 'ebike',   L: 1.7, W: 0.6, v: 4.5, max: 4000 },
  { id: 'lorry',   L: 8.0, W: 2.4, v: 5.0, max: 3000 },
  { id: 'jeep',    L: 4.4, W: 1.9, v: 6.0, max: 2000 },
  { id: 'bus',     L: 9.0, W: 2.5, v: 5.5, max: 1000 },
  { id: 'other',   L: 6.0, W: 2.4, v: 4.5, max: 6000 },
];

const PHYS = { cell: 6, gap: 0.1, tries: 80, failStreak: 1500, subDt: 0.12, maxSub: 3, relaneAfter: 2, reverseAfter: 12 };

// Shared TypedArrays for zero-overhead background physics
const V = {
  n: 0,
  e: new Int32Array(MAX_VEHICLES), s: new Float32Array(MAX_VEHICLES), dir: new Int8Array(MAX_VEHICLES),
  jit: new Float32Array(MAX_VEHICLES), type: new Uint8Array(MAX_VEHICLES), lat: new Float32Array(MAX_VEHICLES),
  park: new Float32Array(MAX_VEHICLES), side: new Int8Array(MAX_VEHICLES), stuck: new Float32Array(MAX_VEHICLES),
  x: new Float32Array(MAX_VEHICLES), y: new Float32Array(MAX_VEHICLES),
  hx: new Float32Array(MAX_VEHICLES), hy: new Float32Array(MAX_VEHICLES),
};
const PARKED = new Uint8Array(MAX_VEHICLES);
const counts = new Int32Array(TYPES.length);
const placed = new Int32Array(TYPES.length);
const FP = new Float32Array(TYPES.length);
const TV = new Float32Array(TYPES.length);
const HL = new Float32Array(TYPES.length);
const HW = new Float32Array(TYPES.length);
const RAD = new Float32Array(TYPES.length);
let RMAX = 0;
let dirtyCells = new Int32Array(MAX_VEHICLES);
let dirtyCount = 0;

TYPES.forEach((t, i) => {
  FP[i] = t.L * t.W; TV[i] = t.v;
  HL[i] = t.L / 2 + PHYS.gap / 2; HW[i] = t.W / 2 + PHYS.gap / 2;
  RAD[i] = Math.hypot(HL[i], HW[i]);
});

function updateRmax() {
  RMAX = 0;
  for (let t = 0; t < TYPES.length; t++) if (placed[t] > 0 && RAD[t] > RMAX) RMAX = RAD[t];
}

let state = { parkShare: 0, parkStrip: 2.3, jam: 0.5, slow: false };

// --- Network & Spatial Logic ---
function initNetwork(rawNet) {
  const E = rawNet.edges.length, N = rawNet.nodes.length;
  let P = 0; for (const e of rawNet.edges) P += e.p.length / 2;
  net = {
    E, N,
    u: new Int32Array(E), v: new Int32Array(E), w0: new Float32Array(E), len: new Float32Array(E),
    off: new Int32Array(E + 1),
    px: new Float32Array(P), py: new Float32Array(P), cum: new Float32Array(P),
    ewS: new Float32Array(E), Ae: new Float32Array(E), cumArea: new Float64Array(E),
    occ: new Float32Array(E), cov: new Float32Array(E), spdF: new Float32Array(E).fill(1),
    bkt: new Uint8Array(E)
  };
  let k = 0, sumA = 0;
  rawNet.edges.forEach((e, i) => {
    net.u[i] = e.u; net.v[i] = e.v; net.w0[i] = e.w; net.off[i] = k;
    let c = 0;
    for (let j = 0; j < e.p.length; j += 2) {
      const x = e.p[j], y = e.p[j + 1];
      if (j > 0) c += Math.hypot(x - net.px[k - 1], y - net.py[k - 1]);
      net.px[k] = x; net.py[k] = y; net.cum[k] = c; k++;
    }
    net.len[i] = Math.max(c, 0.01);
    sumA += net.len[i] * e.w;
    net.cumArea[i] = sumA;
  });
  net.off[E] = k;
  net.totalWeight = sumA;
  net.kappa = (rawNet.meta && rawNet.meta.area_m2 ? rawNet.meta.area_m2 : sumA) / sumA;

  // Adjacency
  const deg = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) { deg[net.u[i] + 1]++; deg[net.v[i] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  net.adjOff = deg.slice();
  net.adjE = new Int32Array(deg[N]);
  const fill = deg.slice(0, N);
  for (let i = 0; i < E; i++) { net.adjE[fill[net.u[i]]++] = i; net.adjE[fill[net.v[i]]++] = i; }
}

function updateRoadWidths(scale) {
  for (let i = 0; i < net.E; i++) {
    net.ewS[i] = net.w0[i] * scale;
    net.Ae[i] = net.len[i] * net.ewS[i] * net.kappa;
  }
}

function buildGrid(bounds) {
  const [x0, y0, x1, y1] = bounds, pad = 30;
  let cs = PHYS.cell, nx = Math.ceil((x1 - x0 + 2 * pad) / cs), ny = Math.ceil((y1 - y0 + 2 * pad) / cs);
  G = { cs, nx, ny, x0: x0 - pad, y0: y0 - pad, head: new Int32Array(nx * ny).fill(-1), next: new Int32Array(MAX_VEHICLES) };
  dirtyCount = 0;
}

let PX = 0, PY = 0, PHX = 1, PHY = 0;
function pose(e, s, dir, lat, parked, side, t) {
  const o = net.off[e], last = net.off[e + 1] - 1, cum = net.cum;
  let k = o; while (k < last - 1 && cum[k + 1] < s) k++;
  const x0 = net.px[k], y0 = net.py[k], sl = cum[k + 1] - cum[k];
  let dx = 1, dy = 0, tt = 0;
  if (sl > 1e-6) { dx = (net.px[k + 1] - x0) / sl; dy = (net.py[k + 1] - y0) / sl; tt = s - cum[k]; }
  const W = net.ewS[e];
  let latM = parked ? side * Math.max(0, W * 0.5 - state.parkStrip * 0.5) : dir * lat * Math.max(0, W * 0.5 - TYPES[t].W * 0.5 - (state.parkShare > 0 ? state.parkStrip : 0));
  PX = x0 + dx * tt - dy * latM; PY = y0 + dy * tt + dx * latM;
  PHX = dir * dx; PHY = dir * dy;
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
  let r = Math.random() * tot;
  for (let k = a; k < b; k++) {
    const ee = net.adjE[k]; if (ee === from) continue;
    r -= net.w0[ee]; if (r <= 0) return ee;
  }
  return net.adjE[a];
}

function gridInsert(i) {
  let cx = Math.floor((V.x[i] - G.x0) / G.cs), cy = Math.floor((V.y[i] - G.y0) / G.cs);
  if (cx < 0) cx = 0; else if (cx >= G.nx) cx = G.nx - 1;
  if (cy < 0) cy = 0; else if (cy >= G.ny) cy = G.ny - 1;
  const c = cy * G.nx + cx;
  if (G.head[c] === -1) dirtyCells[dirtyCount++] = c;
  G.next[i] = G.head[c]; G.head[c] = i;
}

function rebuildGrid() {
  for (let k = 0; k < dirtyCount; k++) G.head[dirtyCells[k]] = -1;
  dirtyCount = 0;
  for (let i = 0; i < V.n; i++) gridInsert(i);
}

function rectsOverlap(ax, ay, ahx, ahy, aL, aW, bx, by, bhx, bhy, bL, bW) {
  const dx = bx - ax, dy = by - ay;
  const sep = (ux, uy) => Math.abs(dx * ux + dy * uy) > (aL * Math.abs(ahx * ux + ahy * uy) + aW * Math.abs(-ahy * ux + ahx * uy)) + (bL * Math.abs(bhx * ux + bhy * uy) + bW * Math.abs(-bhy * ux + bhx * uy));
  return !(sep(ahx, ahy) || sep(-ahy, ahx) || sep(bhx, bhy) || sep(-bhy, bhx));
}

function overlapsAny(x, y, hx, hy, t, self) {
  const cs = G.cs, nx = G.nx, ny = G.ny, reach = RAD[t] + RMAX + 1.5;
  let cx0 = Math.max(0, Math.floor((x - reach - G.x0) / cs)), cx1 = Math.min(nx - 1, Math.floor((x + reach - G.x0) / cs));
  let cy0 = Math.max(0, Math.floor((y - reach - G.y0) / cs)), cy1 = Math.min(ny - 1, Math.floor((y + reach - G.y0) / cs));
  const aL = HL[t], aW = HW[t], r = RAD[t];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      let j = G.head[cy * nx + cx];
      while (j !== -1) {
        if (j !== self) {
          const tj = V.type[j], dx = V.x[j] - x, dy = V.y[j] - y;
          if (dx * dx + dy * dy < (r + RAD[tj]) ** 2 && rectsOverlap(x, y, hx, hy, aL, aW, V.x[j], V.y[j], V.hx[j], V.hy[j], HL[tj], HW[tj])) return true;
        }
        j = G.next[j];
      }
    }
  }
  return false;
}

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
      gridInsert(i); V.n++; return true;
    }
  }
  return false;
}

function removeVehicles(t, k) {
  let i = V.n - 1;
  while (k > 0 && i >= 0) {
    if (V.type[i] === t) {
      const last = V.n - 1;
      V.e[i] = V.e[last]; V.s[i] = V.s[last]; V.dir[i] = V.dir[last]; V.jit[i] = V.jit[last];
      V.type[i] = V.type[last]; V.lat[i] = V.lat[last]; V.park[i] = V.park[last]; V.side[i] = V.side[last];
      V.stuck[i] = V.stuck[last]; PARKED[i] = PARKED[last];
      V.x[i] = V.x[last]; V.y[i] = V.y[last]; V.hx[i] = V.hx[last]; V.hy[i] = V.hy[last];
      V.n--; k--;
    }
    i--;
  }
}

function placeMany(t, need) {
  let ok = 0, streak = 0;
  for (let k = 0; k < need; k++) {
    if (tryPlace(t)) { ok++; streak = 0; }
    else if (++streak >= PHYS.failStreak) break;
  }
  return ok;
}

function setCount(t, want) {
  want = Math.max(0, Math.floor(want));
  let cur = counts[t];
  if (want > cur) { placed[t] += placeMany(t, want - cur); }
  else if (want < cur) {
    let rem = cur - want;
    rem -= Math.min(cur - placed[t], rem);
    if (rem > 0) { removeVehicles(t, rem); placed[t] -= rem; rebuildGrid(); }
  }
  counts[t] = want;
  updateRmax();
}

function stepSimulation(dt) {
  const nSub = Math.min(PHYS.maxSub, Math.max(1, Math.ceil(dt / PHYS.subDt)));
  const h = Math.min(dt / nSub, PHYS.subDt);
  net.occ.fill(0);
  rebuildGrid();
  let sumV = 0, sumF = 0, mv = 0, parkedN = 0, parkedFP = 0, blockedN = 0;

  for (let i = 0; i < V.n; i++) {
    const t = V.type[i], e = V.e[i];
    net.occ[e] += FP[t];
    if (PARKED[i]) { parkedN++; parkedFP += FP[t]; continue; }
    const base = TV[t] * V.jit[i], sp = base * net.spdF[e];
    mv++; sumF += base;
    const s = V.s[i], dir = V.dir[i];

    let ne = e, ns = s + dir * sp * h, nd = dir;
    const L = net.len[e];
    if (ns >= L) {
      let over = ns - L; const nx = pickNext(net.v[e], e);
      const Ln = net.len[nx]; over = Math.min(over, Ln);
      nd = net.u[nx] === net.v[e] ? 1 : -1; ns = nd === 1 ? over : Ln - over; ne = nx;
    } else if (ns <= 0) {
      let over = -ns; const nx = pickNext(net.u[e], e);
      const Ln = net.len[nx]; over = Math.min(over, Ln);
      nd = net.u[nx] === net.u[e] ? 1 : -1; ns = nd === 1 ? over : Ln - over; ne = nx;
    }
    pose(ne, ns, nd, V.lat[i], false, 0, t);
    if (!overlapsAny(PX, PY, PHX, PHY, t, i)) {
      V.e[i] = ne; V.s[i] = ns; V.dir[i] = nd; V.stuck[i] = 0;
      V.x[i] = PX; V.y[i] = PY; V.hx[i] = PHX; V.hy[i] = PHY;
      sumV += sp;
    } else {
      blockedN++;
      if ((V.stuck[i] += h) > PHYS.relaneAfter) V.lat[i] = Math.random();
    }
  }

  let congArea = 0;
  for (let e = 0; e < net.E; e++) {
    const cov = net.occ[e] / net.Ae[e];
    net.cov[e] = cov;
    const r = cov / state.jam;
    net.spdF[e] = state.slow ? Math.max(0.03, 1 - r) : 1;
    net.bkt[e] = r >= 1 ? 6 : Math.floor(r * 6);
    if (r >= 0.8) congArea += net.Ae[e];
  }

  return {
    stats: { mv, parkedN, parkedFP, sumV, sumF, congArea, blockedN },
    vehicles: { x: V.x, y: V.y, hx: V.hx, hy: V.hy, type: V.type, n: V.n },
    bkt: net.bkt
  };
}

// Listen to Main Thread Messages
onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'INIT') {
    initNetwork(msg.rawNet);
    buildGrid(msg.bounds);
    postMessage({ type: 'READY' });
  } else if (msg.type === 'UPDATE_AREA') {
    updateRoadWidths(msg.scale);
  } else if (msg.type === 'SET_COUNTS') {
    msg.counts.forEach((c, i) => setCount(i, c));
  } else if (msg.type === 'STEP') {
    state.jam = msg.jam; state.slow = msg.slow; state.parkShare = msg.parkShare;
    const result = stepSimulation(msg.dt);
    postMessage({ type: 'TICK', ...result }, [result.vehicles.x.buffer, result.vehicles.y.buffer]);
  }
};
