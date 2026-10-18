/* core.js - the simulation engine.  No DOM access: runs inside worker.js, or on the page as a fallback.
 *
 *   const runner = GM.createRunner((msg, transferList) => ...);   // post() to the other side
 *   runner.handle(msg);                                            // messages from app.js
 *
 * Messages in  : init | params | counts | dims | resetRun | recycle
 * Messages out : {type:'frame', buf, n, gs, bkt, stats, run, simRate, placed, markers}
 *
 * Guarantees
 *  - Placement never overlaps: every new vehicle is tested (oriented-rectangle SAT, spatial hash) against
 *    all vehicles already on the street. Vehicles that do not fit are NOT placed; the page shows the shortfall.
 *  - Movement never overlaps either: a vehicle only advances to a pose that is free, otherwise it waits or
 *    nudges sideways. Because nothing overlaps, collisions are not detected here. The collision figure is a
 *    statistical estimate (Poisson events at the rate the page computes), drawn as flashes on random vehicles.
 *
 * Work is time-boxed per loop iteration, so a slow device lowers the achieved simulation rate (reported as
 * simRate) instead of freezing. Frames are positions only, grouped by (type, parked), in transferable buffers.
 */
(() => {
'use strict';
const GM = globalThis.GM;
const { TYPES, MAX_VEHICLES } = GM;
const nT = TYPES.length;
const PHYS = { cell: 6, gap: 0.1, tries: 24, failStreak: 150, maxStep: 0.12 };
const IS_MAIN = typeof window !== 'undefined' && typeof document !== 'undefined';
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

GM.createRunner = function createRunner(post) {
  const BUDGET_MS = IS_MAIN ? 8 : 30;      // simulation time per loop iteration
  const FRAME_MS = IS_MAIN ? 66 : 50;      // minimum gap between frames while running
  const cap = MAX_VEHICLES;

  /* ------------------------------ parameters ------------------------------ */
  const P = { areaKm2: 0.894, parkShare: 0, parkStrip: 2.3, jam: 0.5, slow: false };
  const C = { on: true, perDay: 0, secPerDay: 20 };
  const S = { simSpeed: 10, paused: false, hidden: false };
  const want = new Int32Array(nT), placed = new Int32Array(nT);
  const FP = new Float32Array(nT), TV = new Float32Array(nT), HL = new Float32Array(nT),
        HW = new Float32Array(nT), RAD = new Float32Array(nT), VW = new Float32Array(nT);
  let RMAX = 0, pgen = 0;

  function setDims(d) {
    for (let t = 0; t < nT; t++) {
      const L = d[t].L, W = d[t].W;
      FP[t] = L * W; TV[t] = d[t].v; VW[t] = W;
      HL[t] = L / 2 + PHYS.gap / 2; HW[t] = W / 2 + PHYS.gap / 2;
      RAD[t] = Math.hypot(HL[t], HW[t]);
    }
  }
  function updateRmax() {
    RMAX = 0;
    for (let t = 0; t < nT; t++) if ((want[t] > 0 || placed[t] > 0) && RAD[t] > RMAX) RMAX = RAD[t];
  }

  /* ------------------------------ vehicles -------------------------------- */
  let net = null, G = null;
  let nv = 0;
  let ve, vs, vdir, vjit, vtype, vlat, vpref, vpark, vside, vpg, vx, vy, vhx, vhy, vparked, vnx, gnext;
  function allocate() {
    ve = new Int32Array(cap); vs = new Float32Array(cap); vdir = new Int8Array(cap); vjit = new Float32Array(cap);
    vtype = new Uint8Array(cap); vlat = new Float32Array(cap); vpref = new Float32Array(cap); vpark = new Float32Array(cap); vside = new Int8Array(cap);
    vpg = new Uint16Array(cap); vx = new Float32Array(cap); vy = new Float32Array(cap);
    vhx = new Float32Array(cap); vhy = new Float32Array(cap); vparked = new Uint8Array(cap); vnx = new Int32Array(cap); gnext = new Int32Array(cap);
  }
  function copyVeh(d, s) {
    ve[d] = ve[s]; vs[d] = vs[s]; vdir[d] = vdir[s]; vjit[d] = vjit[s]; vtype[d] = vtype[s]; vlat[d] = vlat[s]; vpref[d] = vpref[s];
    vpark[d] = vpark[s]; vside[d] = vside[s]; vpg[d] = vpg[s]; vx[d] = vx[s]; vy[d] = vy[s];
    vhx[d] = vhx[s]; vhy[d] = vhy[s]; vparked[d] = vparked[s]; vnx[d] = vnx[s];
  }

  /* ----------------------------- spatial hash ----------------------------- */
  function buildGrid(bounds) {
    const pad = 30, cs = PHYS.cell;
    const x0 = bounds[0] - pad, y0 = bounds[1] - pad;
    const nx = Math.max(1, Math.ceil((bounds[2] - bounds[0] + 2 * pad) / cs));
    const ny = Math.max(1, Math.ceil((bounds[3] - bounds[1] + 2 * pad) / cs));
    G = { cs, inv: 1 / cs, nx, ny, x0, y0, head: new Int32Array(nx * ny).fill(-1) };
  }
  function cellIdx(x, y) {
    let cx = Math.floor((x - G.x0) * G.inv), cy = Math.floor((y - G.y0) * G.inv);
    if (cx < 0) cx = 0; else if (cx >= G.nx) cx = G.nx - 1;
    if (cy < 0) cy = 0; else if (cy >= G.ny) cy = G.ny - 1;
    return cy * G.nx + cx;
  }
  function gridLink(i, c) { gnext[i] = G.head[c]; G.head[c] = i; }
  function gridUnlink(i, c) {
    let j = G.head[c], prev = -1;
    while (j !== -1 && j !== i) { prev = j; j = gnext[j]; }
    if (j === -1) return;
    if (prev === -1) G.head[c] = gnext[j]; else gnext[prev] = gnext[j];
  }
  function rebuildGrid() {
    G.head.fill(-1);
    for (let i = 0; i < nv; i++) gridLink(i, cellIdx(vx[i], vy[i]));
  }

  /* ------------------------- geometry / overlap test ----------------------- */
  let PX = 0, PY = 0, PHX = 1, PHY = 0;   // result of the last pose call
  function poseAt(e, s, dir, latM) {
    const o = net.off[e], last = net.off[e + 1] - 1, cum = net.cum;
    let k = o;
    while (k < last - 1 && cum[k + 1] < s) k++;
    const x0 = net.px[k], y0 = net.py[k], sl = cum[k + 1] - cum[k];
    let dx = 1, dy = 0, tt = 0;
    if (sl > 1e-6) { dx = (net.px[k + 1] - x0) / sl; dy = (net.py[k + 1] - y0) / sl; tt = s - cum[k]; }
    PX = x0 + dx * tt - dy * latM; PY = y0 + dy * tt + dx * latM;
    PHX = dir * dx; PHY = dir * dy;
  }
  // lat = signed fraction of the free half-width, left of the edge's forward direction when > 0.
  // Drive on the left: lat has the same sign as the travel direction along the edge.
  function poseMoving(e, s, dir, lat, t) {
    poseAt(e, s, dir, lat * Math.max(0, net.ewS[e] * 0.5 - VW[t] * 0.5 - PHYS.gap));
  }
  function poseParked(e, s, side) {
    poseAt(e, s, side, side * Math.max(0, net.ewS[e] * 0.5 - P.parkStrip * 0.5));
  }

  function rectsOverlap(ax, ay, ahx, ahy, aL, aW, bx, by, bhx, bhy, bL, bW) {
    const dx = bx - ax, dy = by - ay;
    const cs = ahx * bhx + ahy * bhy, sn = ahx * bhy - ahy * bhx;
    const c = cs < 0 ? -cs : cs, s = sn < 0 ? -sn : sn;
    let p = dx * ahx + dy * ahy; if (p < 0) p = -p;
    if (p > aL + bL * c + bW * s) return false;
    p = -dx * ahy + dy * ahx; if (p < 0) p = -p;
    if (p > aW + bL * s + bW * c) return false;
    p = dx * bhx + dy * bhy; if (p < 0) p = -p;
    if (p > bL + aL * c + aW * s) return false;
    p = -dx * bhy + dy * bhx; if (p < 0) p = -p;
    if (p > bW + aL * s + aW * c) return false;
    return true;
  }

  function overlapsAny(x, y, hx, hy, t, self) {
    const cs = G.cs, nx = G.nx, reach = RAD[t] + RMAX;
    const cx0 = Math.max(0, Math.floor((x - reach - G.x0) * G.inv)), cx1 = Math.min(nx - 1, Math.floor((x + reach - G.x0) * G.inv));
    const cy0 = Math.max(0, Math.floor((y - reach - G.y0) * G.inv)), cy1 = Math.min(G.ny - 1, Math.floor((y + reach - G.y0) * G.inv));
    const aL = HL[t], aW = HW[t], r = RAD[t];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let j = G.head[cy * nx + cx];
        while (j !== -1) {
          if (j !== self) {
            const tj = vtype[j], dx = vx[j] - x, dy = vy[j] - y, rr = r + RAD[tj];
            if (dx * dx + dy * dy < rr * rr && rectsOverlap(x, y, hx, hy, aL, aW, vx[j], vy[j], vhx[j], vhy[j], HL[tj], HW[tj])) return true;
          }
          j = gnext[j];
        }
      }
    }
    return false;
  }

  // The cell is always derived from the STORED (float32) position, so unlink/link never disagree at cell borders.
  function commitPose(i, e, s, dir, lat) {
    const c0 = cellIdx(vx[i], vy[i]);
    ve[i] = e; vs[i] = s; vdir[i] = dir; vlat[i] = lat;
    vx[i] = PX; vy[i] = PY; vhx[i] = PHX; vhy[i] = PHY;
    const c1 = cellIdx(vx[i], vy[i]);
    if (c0 !== c1) { gridUnlink(i, c0); gridLink(i, c1); }
  }

  /* --------------------------- placement / removal -------------------------- */
  function sampleEdge() {
    const r = Math.random() * net.cumArea[net.E - 1];
    let lo = 0, hi = net.E - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (net.cumArea[m] < r) lo = m + 1; else hi = m; }
    return lo;
  }

  function tryPlace(t) {
    if (nv >= cap) return false;
    const pv = Math.random(), wantPark = pv < P.parkShare;
    for (let k = 0; k < PHYS.tries; k++) {
      const e = sampleEdge(), zb = stopDist(e), s = zb + Math.random() * (net.len[e] - 2 * zb);   // never inside a junction box
      const parked = wantPark && k < PHYS.tries * 0.7;
      let dir, lat = 0, side = 0;
      if (parked) { side = Math.random() < 0.5 ? 1 : -1; dir = side; poseParked(e, s, side); }
      else { dir = Math.random() < 0.5 ? 1 : -1; lat = dir * (0.05 + Math.random() * 0.90); poseMoving(e, s, dir, lat, t); }
      if (overlapsAny(PX, PY, PHX, PHY, t, -1)) continue;
      const i = nv;
      ve[i] = e; vs[i] = s; vdir[i] = dir; vlat[i] = lat; vpref[i] = Math.abs(lat) || 0.55; vside[i] = side; vtype[i] = t;
      vjit[i] = 0.8 + 0.4 * Math.random(); vpark[i] = pv; vpg[i] = pgen; vparked[i] = parked ? 1 : 0;
      vx[i] = PX; vy[i] = PY; vhx[i] = PHX; vhy[i] = PHY; vnx[i] = pickNext(dir === 1 ? net.v[e] : net.u[e], e);
      gridLink(i, cellIdx(vx[i], vy[i])); nv++;
      return true;
    }
    return false;
  }

  function placeMany(t, need) {
    let ok = 0, streak = 0;
    for (let k = 0; k < need; k++) {
      if (tryPlace(t)) { ok++; streak = 0; }
      else if (++streak >= PHYS.failStreak) break;      // street is full for this type
    }
    return ok;
  }

  function removeVehicles(t, k) {
    for (let i = nv - 1; i >= 0 && k > 0; i--) {
      if (vtype[i] !== t) continue;
      const last = nv - 1;
      if (i !== last) copyVeh(i, last);
      nv--; k--;
    }
  }

  const bigFirst = TYPES.map((_, i) => i).sort((a, b) => (TYPES[b].L * TYPES[b].W) - (TYPES[a].L * TYPES[a].W));

  // Incremental change of the fleet: remove surplus, then try to place what is missing (including
  // vehicles that did not fit earlier, in case there is room now).
  function applyCounts(arr) {
    let tot = 0;
    for (let t = 0; t < nT; t++) { want[t] = Math.max(0, Math.min(Math.floor(arr[t]) || 0, cap - tot)); tot += want[t]; }
    updateRmax();
    let removed = false;
    for (let t = 0; t < nT; t++) {
      if (placed[t] > want[t]) { removeVehicles(t, placed[t] - want[t]); placed[t] = want[t]; removed = true; }
    }
    if (removed) rebuildGrid();
    for (const t of bigFirst) if (placed[t] < want[t]) placed[t] += placeMany(t, want[t] - placed[t]);
    covStale = true;
  }

  // Full re-placement (street widths or vehicle dimensions changed, so old poses may now overlap).
  function replaceAll() {
    nv = 0; placed.fill(0); G.head.fill(-1);
    updateRmax();
    for (const t of bigFirst) placed[t] = placeMany(t, want[t]);
    covStale = true;
  }

  /* ------------------------ parking (gradual reconcile) --------------------- */
  const FREE_LATS = [0.55, 0.85, 0.3];
  function toParked(i) {
    const e = ve[i], s = vs[i], t = vtype[i], first = Math.random() < 0.5 ? 1 : -1;
    for (let a = 0; a < 2; a++) {
      const side = a ? -first : first;
      poseParked(e, s, side);
      if (!overlapsAny(PX, PY, PHX, PHY, t, i)) { commitPose(i, e, s, side, 0); vside[i] = side; vparked[i] = 1; vpg[i] = pgen; return true; }
    }
    return false;
  }
  function toMoving(i) {
    const e = ve[i], s = vs[i], t = vtype[i], dir = vdir[i];
    for (let a = 0; a < FREE_LATS.length; a++) {
      const lat = dir * FREE_LATS[a];
      poseMoving(e, s, dir, lat, t);
      if (!overlapsAny(PX, PY, PHX, PHY, t, i)) { commitPose(i, e, s, dir, lat); vpref[i] = FREE_LATS[a]; vside[i] = 0; vparked[i] = 0; vnx[i] = pickNext(dir === 1 ? net.v[e] : net.u[e], e); return true; }
    }
    return false;
  }
  function reposePark(i) {
    vpg[i] = pgen;
    poseParked(ve[i], vs[i], vside[i]);
    if (!overlapsAny(PX, PY, PHX, PHY, vtype[i], i)) { commitPose(i, ve[i], vs[i], vside[i], 0); return true; }
    return false;
  }
  // A vehicle is parked iff its fixed random draw < parkShare. Transitions are attempted a slice at a time;
  // a vehicle whose spot is blocked simply keeps its state and is retried on the next pass.
  let cursor = 0;
  function reconcile(maxScan) {
    if (nv === 0) return false;
    let changed = false;
    const steps = Math.min(nv, maxScan);
    for (let k = 0; k < steps; k++) {
      if (cursor >= nv) cursor = 0;
      const i = cursor++;
      const wantP = vpark[i] < P.parkShare ? 1 : 0;
      if (wantP !== vparked[i]) { if (wantP ? toParked(i) : toMoving(i)) changed = true; }
      else if (vparked[i] && vpg[i] !== pgen) { if (reposePark(i)) changed = true; }
    }
    return changed;
  }

  /* -------------------------------- movement -------------------------------- */
  function pickNext(node, from) {
    const a = net.adjOff[node], b = net.adjOff[node + 1], adj = net.adjE;
    let cnt = 0;
    for (let k = a; k < b; k++) if (adj[k] !== from) cnt++;
    if (cnt === 0) return from;
    let r = Math.floor(Math.random() * cnt);
    for (let k = a; k < b; k++) if (adj[k] !== from && r-- === 0) return adj[k];
    return from;
  }

  // Junctions. A vehicle never stands inside a junction box: it stops at a stop line ZB metres before the node
  // and, when there is room for it on the street it wants to take, crosses the box in one step. Crossing
  // vehicles therefore never meet in the middle of a junction (the cause of permanent lock-ups when every
  // vehicle is a physical rectangle), and a vehicle only waits for the vehicle ahead or for room on its exit.
  const ZB = 4.0;
  const stopDist = (e) => Math.min(ZB, net.len[e] * 0.45);

  // Move vehicle i forward by d metres with lateral position nlat. Commits only if the target pose is free of
  // other vehicles. Steps are <= ~1 m, below the length of the shortest vehicle, so nothing is jumped over
  // on a street; across a junction the destination is checked instead.
  function tryMove(i, d, nlat) {
    const t = vtype[i], e = ve[i], dir = vdir[i], L = net.len[e], zb = stopDist(e);
    const lo = zb, hi = L - zb;
    let s = vs[i] + dir * d;
    if (dir === 1 ? s > hi : s < lo) {
      const over = dir === 1 ? s - hi : lo - s;
      const node = dir === 1 ? net.v[e] : net.u[e];
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? vnx[i] : pickNext(node, e);          // if the planned street is full, try others
        if (k > 0 && nx === vnx[i]) continue;
        const nd = nx === e ? -dir : (net.u[nx] === node ? 1 : -1);
        const zn = stopDist(nx), Ln = net.len[nx];
        let sd = nd === 1 ? zn + over : Ln - zn - over;
        if (sd < zn) sd = zn; else if (sd > Ln - zn) sd = Ln - zn;
        const lat = nd * Math.abs(nlat);
        poseMoving(nx, sd, nd, lat, t);
        if (overlapsAny(PX, PY, PHX, PHY, t, i)) continue;
        commitPose(i, nx, sd, nd, lat);
        vnx[i] = pickNext(nd === 1 ? net.v[nx] : net.u[nx], nx);
        return true;
      }
      s = dir === 1 ? hi : lo;                                      // cannot cross: roll up to the stop line
      if (Math.abs(s - vs[i]) < 0.02) return false;
    }
    nlat = dir * Math.abs(nlat);          // keep to the left of the travel direction
    poseMoving(e, s, dir, nlat, t);
    if (overlapsAny(PX, PY, PHX, PHY, t, i)) return false;
    commitPose(i, e, s, dir, nlat);
    return true;
  }

  // Returns the distance actually travelled (0 = waiting).
  // Tries full speed, then closing up to the vehicle ahead in smaller steps, then a sideways yield.
  function advance(i, d) {
    const dir = vdir[i], lat0 = vlat[i];
    let dl = dir * vpref[i] - lat0; dl = dl > 0.2 ? 0.2 : dl < -0.2 ? -0.2 : dl;     // drift back toward own lane
    const nl = lat0 + dl;
    if (tryMove(i, d, nl)) return d;
    if (tryMove(i, d * 0.45, nl)) return d * 0.45;
    if (tryMove(i, d * 0.15, nl)) return d * 0.15;
    let da = dir * (Math.random() < 0.5 ? 0.95 : 0.15) - lat0; da = da > 0.2 ? 0.2 : da < -0.2 ? -0.2 : da;   // yield sideways, own half only
    if (tryMove(i, d * 0.5, lat0 + da)) return d * 0.5;
    // still waiting at a stop line: reconsider which street to take next
    if (Math.random() < 0.3) vnx[i] = pickNext(dir === 1 ? net.v[ve[i]] : net.u[ve[i]], ve[i]);
    return 0;
  }

  const acc = { steps: 0, mv: 0, blocked: 0, sumV: 0, sumF: 0 };
  function substep(h) {
    let mv = 0, blocked = 0, sumV = 0, sumF = 0;
    const off = (Math.random() * nv) | 0, spd = net.spdF;
    for (let c = 0; c < nv; c++) {
      let i = c + off; if (i >= nv) i -= nv;       // rotating start: nobody has permanent priority
      if (vparked[i]) continue;
      const t = vtype[i], free = TV[t] * vjit[i];
      mv++; sumF += free;
      const moved = advance(i, free * spd[ve[i]] * h);
      if (moved > 0) sumV += moved / h; else blocked++;
    }
    acc.steps++; acc.mv += mv; acc.blocked += blocked; acc.sumV += sumV; acc.sumF += sumF;
  }

  /* ----------------------- coverage, speed factor, colours ------------------- */
  let covStale = true, parkedN = 0, parkedFP = 0, congArea = 0;
  function refreshCoverage() {
    const occ = net.occ, E = net.E;
    occ.fill(0); parkedN = 0; parkedFP = 0;
    for (let i = 0; i < nv; i++) {
      const f = FP[vtype[i]];
      occ[ve[i]] += f;
      if (vparked[i]) { parkedN++; parkedFP += f; }
    }
    congArea = 0;
    const jam = Math.max(0.01, P.jam);
    for (let e = 0; e < E; e++) {
      const Ae = net.len[e] * net.ewS[e];
      const r = Ae > 0 ? occ[e] / Ae / jam : 0;
      net.spdF[e] = P.slow ? Math.max(0.03, 1 - r) : 1;
      net.bkt[e] = r >= 1 ? 6 : Math.max(0, Math.floor(r * 6));
      if (r >= 0.8) congArea += Ae;
    }
    covStale = false;
  }

  /* -------------------------- collision estimate (Poisson) ------------------- */
  function randn() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
  function poisson(l) {
    if (!(l > 0)) return 0;
    if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * randn()));
    const lim = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > lim);
    return k - 1;
  }
  const run = { events: 0, days: 0 };
  let markers = [];
  function collisionStep(dtReal) {
    const spd = Math.max(1, C.secPerDay);
    run.days += dtReal / spd;
    const k = Math.min(40, poisson(C.perDay * dtReal / spd));
    run.events += k;
    for (let q = 0; q < k && nv > 0 && markers.length < 100; q++) {
      let i = (Math.random() * nv) | 0;
      for (let tries = 0; tries < 8 && vparked[i]; tries++) i = (Math.random() * nv) | 0;
      markers.push({ x: vx[i], y: vy[i] });
    }
  }

  /* ---------------------------------- frames -------------------------------- */
  const pool = [];
  let outstanding = 0, simRate = 0, winReal = 0, winSim = 0;
  let last = { mv: 0, blocked: 0, sumV: 0, sumF: 0 };

  function postFrame() {
    if (covStale) refreshCoverage();
    const need = 10 * nv + 16;
    let buf = null;
    while (pool.length) { const b = pool.pop(); if (b.byteLength >= need) { buf = b; break; } }
    if (!buf) buf = new ArrayBuffer(Math.ceil(need * 1.15) + 64);
    const xs = new Float32Array(buf, 0, nv), ys = new Float32Array(buf, 4 * nv, nv);
    const hxs = new Int8Array(buf, 8 * nv, nv), hys = new Int8Array(buf, 9 * nv, nv);
    const gs = new Int32Array(2 * nT + 1);
    for (let i = 0; i < nv; i++) gs[vtype[i] * 2 + vparked[i] + 1]++;
    for (let g = 0; g < 2 * nT; g++) gs[g + 1] += gs[g];
    const cur = gs.slice(0, 2 * nT);
    for (let i = 0; i < nv; i++) {
      const k = cur[vtype[i] * 2 + vparked[i]]++;
      xs[k] = vx[i]; ys[k] = vy[i];
      hxs[k] = Math.round(vhx[i] * 127); hys[k] = Math.round(vhy[i] * 127);
    }
    if (acc.steps > 0) {
      last = { mv: acc.mv / acc.steps, blocked: acc.blocked / acc.steps, sumV: acc.sumV / acc.steps, sumF: acc.sumF / acc.steps };
      acc.steps = acc.mv = acc.blocked = acc.sumV = acc.sumF = 0;
    }
    if (winReal > 0) {
      const inst = winSim / winReal;
      simRate = simRate ? simRate * 0.6 + inst * 0.4 : inst;
      winReal = winSim = 0;
    }
    const moving = nv - parkedN;
    const stats = {
      mv: S.paused || !last.mv ? moving : Math.round(last.mv), parkedN, parkedFP,
      blockedN: Math.min(last.blocked, moving), sumV: last.sumV, sumF: last.sumF, congArea, placedN: nv,
    };
    const m = markers; markers = [];
    outstanding++;
    post({ type: 'frame', buf, n: nv, gs, bkt: net.bkt.slice(), stats, run: { events: run.events, days: run.days },
      simRate, placed: Array.from(placed), markers: m }, [buf]);
  }

  /* ------------------------------------ loop -------------------------------- */
  let timer = null, started = false, lastT = 0, simAcc = 0, lastPost = 0, dirty = true;
  let layoutAt = 0, pendCounts = null;

  function tick() {
    const t0 = nowMs();
    const dtReal = lastT ? Math.min(0.1, (t0 - lastT) / 1000) : 0.016;
    lastT = t0;
    if (pendCounts) { const c = pendCounts; pendCounts = null; applyCounts(c); dirty = true; }
    if (layoutAt && t0 - layoutAt > 150) { layoutAt = 0; replaceAll(); dirty = true; }   // debounced: sliders fire often
    if (reconcile(3000)) { covStale = true; dirty = true; }

    const running = !S.paused && !S.hidden && nv > 0;
    if (running) {
      refreshCoverage();
      simAcc = Math.min(simAcc + dtReal * S.simSpeed, 3);
      let simDone = 0;
      do {
        const h = Math.min(PHYS.maxStep, simAcc);
        substep(h); simAcc -= h; simDone += h;
      } while (simAcc > 1e-4 && nowMs() - t0 < BUDGET_MS);
      simAcc = 0;                       // anything not simulated is dropped; simRate reports the shortfall
      winSim += simDone; winReal += dtReal;
      dirty = true;
    } else simAcc = 0;

    if (C.on && !S.paused && !S.hidden) collisionStep(dtReal);

    const t1 = nowMs();
    if (dirty && outstanding < 4 && t1 - lastPost >= (running ? FRAME_MS : 100)) { postFrame(); lastPost = t1; dirty = false; }
  }

  function loop() {
    timer = null;
    try { tick(); } catch (err) { if (typeof console !== 'undefined') console.error(err); post({ type: 'error', message: String(err && err.stack || err) }); }
    const idle = S.paused || S.hidden || nv === 0;
    timer = setTimeout(loop, idle ? 60 : (IS_MAIN ? 10 : 0));
  }

  /* ---------------------------------- messages ------------------------------- */
  function applyParams(p) {
    const oldArea = P.areaKm2, oldStrip = P.parkStrip;
    Object.assign(P, p.P); Object.assign(C, p.C);
    S.simSpeed = p.simSpeed; S.paused = !!p.paused; S.hidden = !!p.hidden;
    P.jam = Math.max(0.01, P.jam);
    if (net) {
      if (Math.abs(P.areaKm2 - oldArea) > 1e-9) { GM.applyRoadArea(net, P.areaKm2); layoutAt = nowMs(); }
      if (P.parkStrip !== oldStrip) pgen = (pgen + 1) & 0xffff;
    }
    covStale = true; dirty = true;
  }

  function init(m) {
    applyParams(m.p);
    net = GM.prepareNetwork(m.raw);
    GM.applyRoadArea(net, P.areaKm2);
    net.occ = new Float32Array(net.E); net.spdF = new Float32Array(net.E).fill(1);
    setDims(m.dims);
    allocate(); buildGrid(net.bounds);
    nv = 0; placed.fill(0);
    applyCounts(m.counts);
    if (!started) { started = true; lastT = 0; timer = setTimeout(loop, 0); }
  }

  function handle(m) {
    try {
      switch (m.cmd) {
        case 'init': init(m); break;
        case 'params': applyParams(m.p); break;
        case 'counts': pendCounts = m.counts; break;                // latest wins; applied at the next loop iteration
        case 'dims': setDims(m.dims); updateRmax(); layoutAt = nowMs(); dirty = true; break;
        case 'resetRun': run.events = 0; run.days = 0; markers = []; dirty = true; break;
        case 'recycle': outstanding = Math.max(0, outstanding - 1); if (m.buf && pool.length < 4) pool.push(m.buf); break;
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.error(err);
      post({ type: 'error', message: String(err && err.stack || err) });
    }
  }

  return { handle, stop() { if (timer) clearTimeout(timer); started = false; } };
};
})();
