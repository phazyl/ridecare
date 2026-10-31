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
  const P = { areaKm2: 0.894, parkShare: 0, parkShareT: null, parkStrip: 2.3, jam: 0.5, slow: false, patience: 5, safe: false, react: 1.5, mu: 0.6 };
  const C = { on: true, perDay: 0, secPerDay: 20 };
  const S = { simSpeed: 10, paused: false, hidden: false };
  const want = new Int32Array(nT), placed = new Int32Array(nT);
  // Parked share per vehicle type (0..1): the part of that type's fleet that stands at the kerb; the rest moves.
  // P.parkShareT (one value per type, set by the page's clock) wins over the single P.parkShare.
  const PS = new Float32Array(nT);
  function updatePS() {
    let changed = false;
    for (let t = 0; t < nT; t++) {
      let v = P.parkShareT && P.parkShareT.length > t ? P.parkShareT[t] : P.parkShare;
      v = Math.min(1, Math.max(0, +v || 0));
      if (Math.abs(v - PS[t]) > 1e-6) { PS[t] = v; changed = true; }
    }
    return changed;
  }
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
  let ve, vs, vdir, vjit, vtype, vlat, vpref, vpark, vside, vpg, vx, vy, vhx, vhy, vparked, vnx, gnext, vlane, vwait;
  // vlane = sign of the lateral position (vlat) a moving vehicle keeps to, in the edge's forward frame.
  // Two-way street: always equal to vdir (drive on the left). One-way street (vdir is always +1): either
  // +1 (left half) or -1 (right half), so a one-way street is driven on over its full width.
  function allocate() {
    vlane = new Int8Array(cap); vwait = new Float32Array(cap);
    ve = new Int32Array(cap); vs = new Float32Array(cap); vdir = new Int8Array(cap); vjit = new Float32Array(cap);
    vtype = new Uint8Array(cap); vlat = new Float32Array(cap); vpref = new Float32Array(cap); vpark = new Float32Array(cap); vside = new Int8Array(cap);
    vpg = new Uint16Array(cap); vx = new Float32Array(cap); vy = new Float32Array(cap);
    vhx = new Float32Array(cap); vhy = new Float32Array(cap); vparked = new Uint8Array(cap); vnx = new Int32Array(cap); gnext = new Int32Array(cap);
  }
  function copyVeh(d, s) {
    ve[d] = ve[s]; vs[d] = vs[s]; vdir[d] = vdir[s]; vjit[d] = vjit[s]; vtype[d] = vtype[s]; vlat[d] = vlat[s]; vpref[d] = vpref[s];
    vpark[d] = vpark[s]; vside[d] = vside[s]; vpg[d] = vpg[s]; vx[d] = vx[s]; vy[d] = vy[s];
    vhx[d] = vhx[s]; vhy[d] = vhy[s]; vparked[d] = vparked[s]; vnx[d] = vnx[s]; vlane[d] = vlane[s]; vwait[d] = vwait[s];
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
  // Parked vehicles face the direction of travel: on a two-way street that is "away from the junction on its
  // own side" (heading = side); on a one-way street everybody faces forward, on either kerb.
  const parkHeading = (e, side) => (net.ow[e] ? 1 : side);
  function poseParked(e, s, side) {
    poseAt(e, s, parkHeading(e, side), side * Math.max(0, net.ewS[e] * 0.5 - P.parkStrip * 0.5));
  }
  // Kerb strip with rows: row 0 = middle of the strip; narrow vehicles (motorcycles ...) can also stand in two
  // rows side by side (1 = kerb side, 2 = street side) when the strip is wide enough. The row is kept in vlat.
  function poseParkedRow(e, s, side, t, row) {
    const ew = net.ewS[e], base = ew * 0.5 - P.parkStrip * 0.5;
    const dd = row ? Math.max(0, P.parkStrip * 0.5 - HW[t]) : 0;
    const lat = Math.max(0, Math.min(ew * 0.5 - HW[t], Math.max(0, base + (row === 1 ? dd : row === 2 ? -dd : 0))));
    poseAt(e, s, parkHeading(e, side), side * lat);
  }
  // No-parking kerbs: net.pk[e] bit 1 = left kerb closed, bit 2 = right kerb closed (left of the edge's forward direction).
  const isBanned = (e, side) => (net.pk[e] & (side > 0 ? 1 : 2)) !== 0;
  let banScan = false;
  function setNoPark(mask) {
    if (!net || !mask || mask.length !== net.E) return;
    net.pk.set(mask); banScan = true; dirty = true;
  }
  // Street directions changed while vehicles are on the street. Positions never move; vehicles on a changed street
  // are turned to the new legal direction and everybody's planned next street is re-chosen.
  function setStreets(ow, fl, mask) {
    if (!net || !ow || ow.length !== net.E) return;
    const flipped = new Uint8Array(net.E), owWas = new Uint8Array(net.E);
    let any = false;
    for (let e = 0; e < net.E; e++) {
      if ((fl[e] ? 1 : 0) !== net.fl[e]) flipped[e] = 1;
      owWas[e] = net.ow[e];
      if (flipped[e] || (ow[e] ? 1 : 0) !== net.ow[e]) any = true;
    }
    if (any) {
      for (let i = 0; i < nv; i++) {                                   // street reversed: same place, mirrored coordinates
        const e = ve[i]; if (!flipped[e]) continue;
        vs[i] = net.len[e] - vs[i]; vdir[i] = -vdir[i]; vside[i] = -vside[i];
        if (!vparked[i]) { vlat[i] = -vlat[i]; vlane[i] = -vlane[i]; }
      }
      const changed = GM.applyFlow(net, ow, fl);
      for (let i = 0; i < nv; i++) {
        const e = ve[i];
        if (changed.indexOf(e) < 0 && vnx[i] !== -1 && changed.indexOf(vnx[i]) < 0) continue;
        if (changed.indexOf(e) >= 0) {
          let nd = vdir[i];
          if (vparked[i]) nd = net.ow[e] ? 1 : vside[i];
          else if (net.ow[e]) { nd = 1; vlane[i] = vlat[i] < 0 ? -1 : 1; vpref[i] = Math.abs(vlat[i]) || 0.55; }
          else { nd = vdir[i]; vlane[i] = nd; vpref[i] = Math.abs(vlat[i]) || 0.55; }
          if (nd !== vdir[i]) { vdir[i] = nd; vhx[i] = -vhx[i]; vhy[i] = -vhy[i]; }
          vwait[i] = 0;
        }
        if (!vparked[i]) vnx[i] = pickNext(vdir[i] === 1 ? net.v[ve[i]] : net.u[ve[i]], ve[i]);
      }
      dirty = true; covStale = true;
    }
    if (mask) setNoPark(mask);
  }
  const ROWS1 = [0], ROWS2 = [1, 2];
  const rowsFor = (t) => ROWS1;   // one row only: a single vehicle deep along each kerb (ROWS2 = old two-row motorcycle parking)
  let KE = 0, KS = 0, KSIDE = 1, KROW = 0;
  // Look for a free kerb spot for a vehicle of type t (self = its own index, or -1). First fit: from a random
  // point walk along the kerb in steps of one vehicle length. Sets KE/KS/KSIDE/KROW and the pose.
  function parkSpot(t, self) {
    const step = 2 * HL[t], rows = rowsFor(t);
    for (let k = 0; k < PHYS.tries; k++) {
      const e = sampleEdge(), lo = stopDist(e), hi = net.len[e] - lo;
      if (hi - lo < step) continue;
      let side = Math.random() < 0.5 ? 1 : -1;
      if (isBanned(e, side)) { side = -side; if (isBanned(e, side)) continue; }
      let s = lo + Math.random() * (hi - lo);
      for (let j = 0; j < 4 && s <= hi; j++, s += step) {
        const r0 = (Math.random() * rows.length) | 0;
        for (let q = 0; q < rows.length; q++) {
          const row = rows[(r0 + q) % rows.length];
          poseParkedRow(e, s, side, t, row);
          if (!overlapsAny(PX, PY, PHX, PHY, t, self)) { KE = e; KS = s; KSIDE = side; KROW = row; return true; }
        }
      }
    }
    return false;
  }

  // Safe spacing: is the stretch of road ahead of a moving vehicle (length g) free of vehicles travelling the same way?
  function blockedAhead(x, y, hx, hy, t, self, g) {
    const hl = g / 2, cx = x + hx * (HL[t] + hl), cy = y + hy * (HL[t] + hl), hw = HW[t];
    const reach = hl + hw + RMAX + 0.5, cs = G.cs, nx = G.nx;
    const cx0 = Math.max(0, Math.floor((cx - reach - G.x0) * G.inv)), cx1 = Math.min(nx - 1, Math.floor((cx + reach - G.x0) * G.inv));
    const cy0 = Math.max(0, Math.floor((cy - reach - G.y0) * G.inv)), cy1 = Math.min(G.ny - 1, Math.floor((cy + reach - G.y0) * G.inv));
    for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) {
      let j = G.head[gy * nx + gx];
      while (j !== -1) {
        if (j !== self && !vparked[j] && vhx[j] * hx + vhy[j] * hy > 0.3) {
          const tj = vtype[j];
          if (rectsOverlap(cx, cy, hx, hy, hl, hw, vx[j], vy[j], vhx[j], vhy[j], HL[tj], HW[tj])) return true;
        }
        j = gnext[j];
      }
    }
    return false;
  }
  let curH = 0.1;     // length of the current simulation step (s), used to turn a step distance into a speed
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

  // wantPark = true: look for a free kerb spot only; false: look for a free lane spot only.
  function tryPlace(t, wantPark) {
    if (nv >= cap) return false;
    const pv = wantPark ? Math.random() * PS[t] : PS[t] + (1 - PS[t]) * Math.random();
    let e, sPos, dir, lat = 0, side = 0, lane = 1;
    if (wantPark) {
      if (!parkSpot(t, -1)) return false;
      e = KE; sPos = KS; side = KSIDE; lat = KROW; dir = parkHeading(e, side);
    } else {
      let ok = false;
      for (let k = 0; k < PHYS.tries && !ok; k++) {
        e = sampleEdge(); const zb = stopDist(e); sPos = zb + Math.random() * (net.len[e] - 2 * zb);   // never inside a junction box
        const oneWay = net.ow[e] === 1;
        dir = oneWay ? 1 : (Math.random() < 0.5 ? 1 : -1);               // one-way: only the legal direction
        lane = oneWay ? (Math.random() < 0.5 ? 1 : -1) : dir;           // one-way: either half; two-way: keep left
        lat = lane * (0.05 + Math.random() * 0.90); poseMoving(e, sPos, dir, lat, t);
        ok = !overlapsAny(PX, PY, PHX, PHY, t, -1);
      }
      if (!ok) return false;
    }
    const i = nv;
    vlane[i] = lane; vwait[i] = 0;
    ve[i] = e; vs[i] = sPos; vdir[i] = dir; vlat[i] = lat; vpref[i] = Math.abs(lat) || 0.55; vside[i] = side; vtype[i] = t;
    vjit[i] = 0.8 + 0.4 * Math.random(); vpark[i] = pv; vpg[i] = pgen; vparked[i] = wantPark ? 1 : 0;
    vx[i] = PX; vy[i] = PY; vhx[i] = PHX; vhy[i] = PHY; vnx[i] = pickNext(dir === 1 ? net.v[e] : net.u[e], e);
    gridLink(i, cellIdx(vx[i], vy[i])); nv++;
    return true;
  }

  // Per-type counts on the street right now, and the targets the clock asks for.
  const curP = new Int32Array(nT), curM = new Int32Array(nT);
  function countTypes() {
    curP.fill(0); curM.fill(0);
    for (let i = 0; i < nv; i++) { if (vparked[i]) curP[vtype[i]]++; else curM[vtype[i]]++; }
    for (let t = 0; t < nT; t++) placed[t] = curP[t] + curM[t];
  }
  const tgtP = (t) => Math.round(want[t] * PS[t]);
  const tgtM = (t) => want[t] - tgtP(t);

  // Add the vehicles that are missing: parked ones first (they need kerb space that moving traffic would
  // otherwise take), big types first. A type stops after PHYS.failStreak failed spots in a row.
  function fillDeficits(maxTries, maxMs) {
    countTypes();
    const tEnd = nowMs() + maxMs; let tries = 0, got = 0;
    for (let phase = 1; phase >= 0; phase--) {
      for (const t of bigFirst) {
        let streak = 0;
        for (;;) {
          const tot = want[t] - (curP[t] + curM[t]);
          const need = phase ? Math.min(tgtP(t) - curP[t], tot) : Math.min(tgtM(t) - curM[t], tot);
          if (need <= 0 || tries >= maxTries || nowMs() >= tEnd) break;
          tries++;
          if (tryPlace(t, phase)) { got++; streak = 0; if (phase) curP[t]++; else curM[t]++; }
          else if (++streak >= PHYS.failStreak) break;      // no more room for this type
        }
      }
    }
    if (got) { for (let t = 0; t < nT; t++) placed[t] = curP[t] + curM[t]; covStale = true; }
    return got;
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

  // Change of the fleet (or of its parked/moving split): remove surplus, then place what is missing
  // (including vehicles that did not fit earlier, in case there is room now).
  function applyCounts(arr) {
    retryGap = 1000; retryAt = 0;
    let tot = 0;
    for (let t = 0; t < nT; t++) { want[t] = Math.max(0, Math.min(Math.floor(arr[t]) || 0, cap - tot)); tot += want[t]; }
    updateRmax();
    countTypes();
    let removed = false;
    for (let t = 0; t < nT; t++) {
      const have = curP[t] + curM[t];
      if (have > want[t]) { removeVehicles(t, have - want[t]); removed = true; }
    }
    if (removed) rebuildGrid();
    fillDeficits(Infinity, Infinity);
    covStale = true;
  }

  // Full re-placement (street widths or vehicle dimensions changed, so old poses may now overlap).
  function replaceAll() {
    retryGap = 1000; retryAt = 0;
    nv = 0; placed.fill(0); G.head.fill(-1);
    updateRmax();
    fillDeficits(Infinity, Infinity);
    covStale = true;
  }

  /* ------------------------ parking (gradual reconcile) --------------------- */
  const FREE_LATS = [0.55, 0.85, 0.3];
  function toParked(i) {
    const e = ve[i], sp = vs[i], t = vtype[i], first = Math.random() < 0.5 ? 1 : -1, rows = rowsFor(t);
    for (let a = 0; a < 2; a++) {
      const side = a ? -first : first;
      if (isBanned(e, side)) continue;
      for (const row of rows) {
        poseParkedRow(e, sp, side, t, row);
        if (!overlapsAny(PX, PY, PHX, PHY, t, i)) { commitPose(i, e, sp, parkHeading(e, side), row); vside[i] = side; vparked[i] = 1; vpg[i] = pgen; vwait[i] = 0; return true; }
      }
    }
    return false;
  }
  function toMoving(i) {
    const e = ve[i], s = vs[i], t = vtype[i], dir = vdir[i];
    const lane = net.ow[e] ? (Math.random() < 0.5 ? 1 : -1) : dir;     // one-way: either half; two-way: keep left
    for (let a = 0; a < FREE_LATS.length; a++) {
      const lat = lane * FREE_LATS[a];
      poseMoving(e, s, dir, lat, t);
      if (!overlapsAny(PX, PY, PHX, PHY, t, i)) { commitPose(i, e, s, dir, lat); vlane[i] = lane; vpref[i] = FREE_LATS[a]; vside[i] = 0; vparked[i] = 0; vwait[i] = 0; vnx[i] = pickNext(dir === 1 ? net.v[e] : net.u[e], e); return true; }
    }
    return false;
  }
  function reposePark(i) {
    vpg[i] = pgen;
    const t = vtype[i], row = rowsFor(t).includes(vlat[i]) ? vlat[i] : rowsFor(t)[0];
    poseParkedRow(ve[i], vs[i], vside[i], t, row);
    if (!overlapsAny(PX, PY, PHX, PHY, t, i)) { commitPose(i, ve[i], vs[i], vdir[i], row); return true; }   // vdir = parked heading
    return false;
  }
  // Moving <-> parked as the clock changes the parked share. Every 250 ms: count both groups per type, convert the
  // surplus (a moving vehicle drives to a free kerb spot; a parked one pulls out), then add what is still missing.
  // A vehicle that wants to park but finds no kerb space anywhere it looks is taken off the street: in the model it
  // is parked off-street (garage, lot, elsewhere). It is counted as "no room" until a kerb spot opens up.
  let balAt = 0, retryAt = 0, retryGap = 1000, cursor = 0;
  const surM = new Int32Array(nT), surP = new Int32Array(nT);
  function toParkedSeek(i) {
    if (toParked(i)) return true;                                   // right where it stands, either kerb side
    if (!parkSpot(vtype[i], i)) return false;                       // otherwise look for a free kerb spot elsewhere
    commitPose(i, KE, KS, parkHeading(KE, KSIDE), KROW);
    vside[i] = KSIDE; vparked[i] = 1; vpg[i] = pgen; vwait[i] = 0;
    return true;
  }
  function balance(t0) {
    if (!net || t0 - balAt < 250) return false;
    balAt = t0;
    countTypes();
    let anySur = false;
    for (let t = 0; t < nT; t++) {
      surM[t] = Math.max(0, curM[t] - tgtM(t)); surP[t] = Math.max(0, curP[t] - tgtP(t));
      if (surM[t] || surP[t]) anySur = true;
    }
    let changed = false;
    const rm = [], steps = banScan ? nv : Math.min(nv, anySur ? 25000 : 6000);
    banScan = false;
    for (let k = 0; k < steps; k++) {
      if (cursor >= nv) cursor = 0;
      const i = cursor++, t = vtype[i];
      if (vparked[i]) {
        if (isBanned(ve[i], vside[i])) { if (toMoving(i)) changed = true; }      // parked on a kerb that is now closed: pull out
        else if (surP[t] > 0) { if (toMoving(i)) { surP[t]--; changed = true; } }
        else if (vpg[i] !== pgen) { if (reposePark(i)) changed = true; }
      } else if (surM[t] > 0) {
        surM[t]--; changed = true;
        if (!toParkedSeek(i)) rm.push(i);
      }
    }
    if (rm.length) {
      rm.sort((a, b) => b - a);
      for (const i of rm) { const last = nv - 1; if (i !== last) copyVeh(i, last); nv--; }
      rebuildGrid();
    }
    if (changed) { countTypes(); covStale = true; }
    if (t0 >= retryAt) {                                              // vehicles that did not fit: retry with back-off (1 s to 8 s)
      const got = fillDeficits(240, 3);
      if (got) { retryGap = 1000; changed = true; } else retryGap = Math.min(8000, retryGap * 2);
      retryAt = t0 + retryGap;
    }
    return changed;
  }

  /* -------------------------------- movement -------------------------------- */
  // Next street at a junction, chosen among the streets that may be entered there (net.adjE only lists a
  // one-way street at its start). Dead end: a two-way street turns around; a one-way street has no legal
  // way on and gives -1 (the vehicle waits at the stop line; the exporter prunes such streets).
  function pickNext(node, from) {
    const a = net.adjOff[node], b = net.adjOff[node + 1], adj = net.adjE;
    let cnt = 0;
    for (let k = a; k < b; k++) if (adj[k] !== from) cnt++;
    if (cnt === 0) return net.ow[from] ? -1 : from;
    let r = Math.floor(Math.random() * cnt);
    for (let k = a; k < b; k++) if (adj[k] !== from && r-- === 0) return adj[k];
    return net.ow[from] ? -1 : from;
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
        if (nx < 0 || (k > 0 && nx === vnx[i])) continue;         // nx < 0: no legal way on from a one-way street
        const nd = nx === e ? -dir : (net.u[nx] === node ? 1 : -1);   // one-way streets are only ever entered at u, so nd = 1
        const zn = stopDist(nx), Ln = net.len[nx];
        let sd = nd === 1 ? zn + over : Ln - zn - over;
        if (sd < zn) sd = zn; else if (sd > Ln - zn) sd = Ln - zn;
        const lane = net.ow[nx] ? (Math.random() < 0.5 ? 1 : -1) : nd;   // one-way: pick a half; two-way: keep left
        const lat = lane * Math.abs(nlat);
        poseMoving(nx, sd, nd, lat, t);
        if (overlapsAny(PX, PY, PHX, PHY, t, i)) continue;
        commitPose(i, nx, sd, nd, lat);
        vlane[i] = lane;
        vnx[i] = pickNext(nd === 1 ? net.v[nx] : net.u[nx], nx);
        return true;
      }
      s = dir === 1 ? hi : lo;                                      // cannot cross: roll up to the stop line
      if (Math.abs(s - vs[i]) < 0.02) return false;
    }
    nlat = vlane[i] * Math.abs(nlat);     // keep to the left of the travel direction (one-way streets: to the chosen half)
    poseMoving(e, s, dir, nlat, t);
    if (overlapsAny(PX, PY, PHX, PHY, t, i)) return false;
    if (P.safe && d > 0) {                                           // keep reaction + braking distance to the vehicle ahead
      const v = d / curH, mu = Math.max(0.05, +P.mu || 0.6), g = v * Math.max(0, +P.react || 0) + v * v / (2 * mu * 9.81);
      if (g > 0.05 && blockedAhead(PX, PY, PHX, PHY, t, i, g)) return false;
    }
    commitPose(i, e, s, dir, nlat);
    return true;
  }

  // Returns the distance actually travelled (0 = waiting).
  // Tries full speed, then closing up to the vehicle ahead in smaller steps, then a sideways yield.
  function advance(i, d) {
    const dir = vdir[i], lat0 = vlat[i], lane = vlane[i], tt = vtype[i];
    // sideways speed is limited to about 0.7 m/s (a smooth drift, not a jump)
    const half = Math.max(0.3, net.ewS[ve[i]] * 0.5 - VW[tt] * 0.5 - PHYS.gap), mx = Math.min(0.2, 0.7 * curH / half);
    let dl = lane * vpref[i] - lat0; dl = dl > mx ? mx : dl < -mx ? -mx : dl;         // drift toward own lane position
    const nl = lat0 + dl;
    if (tryMove(i, d, nl)) return d;
    if (tryMove(i, d * 0.45, nl)) return d * 0.45;
    if (tryMove(i, d * 0.15, nl)) return d * 0.15;
    if (vwait[i] > 0.6) {                                            // blocked for a while: ease sideways toward the freer side (own half only), and stay there
      const want = Math.abs(lat0) > 0.5 ? 0.15 : 0.95;
      let da = lane * want - lat0; da = da > mx ? mx : da < -mx ? -mx : da;
      if (tryMove(i, d * 0.5, lat0 + da)) { vpref[i] = Math.abs(lat0 + da) || vpref[i]; return d * 0.5; }
    }
    // still waiting at a stop line: reconsider which street to take next
    if (Math.random() < 0.3) vnx[i] = pickNext(dir === 1 ? net.v[ve[i]] : net.u[ve[i]], ve[i]);
    return 0;
  }

  // Gridlock breaker (SUMO's "teleport after timeout"): a vehicle that has not moved for P.patience simulated
  // seconds is lifted out and set down in a free spot elsewhere. A vehicle stuck right at its stop line goes
  // first (it is the head of the jam); one stuck mid-street waits three times as long. Fleet size and the
  // no-overlap rule are untouched, and every relocation is counted so jams are never hidden.
  let relocN = 0;
  function relocate(i) {
    const t = vtype[i];
    for (let k = 0; k < PHYS.tries; k++) {
      const e = sampleEdge(), zb = stopDist(e), s = zb + Math.random() * (net.len[e] - 2 * zb);
      const dir = net.ow[e] ? 1 : (Math.random() < 0.5 ? 1 : -1);
      const lane = net.ow[e] ? (Math.random() < 0.5 ? 1 : -1) : dir;
      const lat = lane * (0.05 + Math.random() * 0.9);
      poseMoving(e, s, dir, lat, t);
      if (overlapsAny(PX, PY, PHX, PHY, t, i)) continue;
      commitPose(i, e, s, dir, lat);
      vlane[i] = lane; vpref[i] = Math.abs(lat) || 0.55; vwait[i] = 0;
      vnx[i] = pickNext(dir === 1 ? net.v[e] : net.u[e], e);
      return true;
    }
    vwait[i] = 0;          // no room anywhere right now: try again after another wait
    return false;
  }

  const acc = { steps: 0, mv: 0, blocked: 0, sumV: 0, sumF: 0 };
  function substep(h) {
    let mv = 0, blocked = 0, sumV = 0, sumF = 0;
    curH = h;
    const off = (Math.random() * nv) | 0, spd = net.spdF;
    for (let c = 0; c < nv; c++) {
      let i = c + off; if (i >= nv) i -= nv;       // rotating start: nobody has permanent priority
      if (vparked[i]) continue;
      const t = vtype[i], free = TV[t] * vjit[i];
      mv++; sumF += free;
      const e0 = ve[i];
      net.ep[e0] += h;
      const moved = advance(i, free * spd[e0] * h);
      if (moved > 0) { sumV += moved / h; vwait[i] = 0; }
      else {
        blocked++; net.eb[e0] += h;
        const w = vwait[i] += h, pat = P.patience;
        if (pat > 0 && w > pat) {
          const e = ve[i], zb = stopDist(e), atLine = Math.abs(vs[i] - (vdir[i] === 1 ? net.len[e] - zb : zb)) < 0.6;
          if (atLine || w > 3 * pat) { if (relocate(i)) relocN++; }
        }
      }
    }
    acc.steps++; acc.mv += mv; acc.blocked += blocked; acc.sumV += sumV; acc.sumF += sumF;
  }

  /* ----------------------- coverage, speed factor, colours ------------------- */
  let covStale = true, parkedN = 0, parkedFP = 0, congArea = 0, effFP = 0, gapFP = 0;
  // Safe-spacing capacity: a MOVING vehicle also needs the road ahead of it for reaction + braking
  //   gap = v*tReact + v^2/(2*mu*g),  v = free-flow speed of its type (x the street's slow-down factor if that option is on).
  // Parked vehicles need no gap. Footprint used for coverage = width x (length + gap).
  function refreshCoverage() {
    const occ = net.occ, E = net.E, safe = !!P.safe, spd = net.spdF;
    const react = Math.max(0, +P.react || 0), mu = Math.max(0.05, +P.mu || 0.6);
    occ.fill(0); parkedN = 0; parkedFP = 0; effFP = 0; gapFP = 0;
    for (let i = 0; i < nv; i++) {
      const t = vtype[i];
      let f = FP[t];
      if (vparked[i]) { parkedN++; parkedFP += f; effFP += f; occ[ve[i]] += f; continue; }
      if (safe) {
        const v = TV[t] * (spd[ve[i]] || 1), g = v * react + v * v / (2 * mu * 9.81);
        const extra = VW[t] * g; f += extra; gapFP += extra;
      }
      effFP += f; occ[ve[i]] += f;
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
      mv: S.paused || !last.mv ? moving : Math.round(last.mv), parkedN, parkedFP, effFP, gapFP,
      blockedN: Math.min(last.blocked, moving), sumV: last.sumV, sumF: last.sumF, congArea, placedN: nv, relocN, simT,
    };
    const m = markers; markers = [];
    outstanding++;
    post({ type: 'frame', buf, n: nv, gs, bkt: net.bkt.slice(), stats, run: { events: run.events, days: run.days },
      simRate, placed: Array.from(placed), markers: m, hot: hotV !== hotPosted ? hot : undefined }, [buf]);
    hotPosted = hotV;
  }


  /* ---------------------- hotspot ranking (live, every ~2 s) ---------------------- */
  // Score = average number of vehicles waiting on a street over the window (vehicle-seconds waiting / window).
  // Neighbouring streets are merged so a queue that spills over several streets counts once.
  let hot = [], hotV = 0, hotPosted = -1, hotAt = 0, hotSim = 0, hotEff = 0, simT = 0;
  const GOODS = TYPES.map((t) => (t.L * t.W >= 9 && t.id !== 'bus') ? 1 : 0);   // vans, pickups, trucks, lorries, other heavy
  const HOT_N = 8, HOT_MERGE = 70, HOT_MIN_Q = 1.5;
  function computeHotspots() {
    const E = net.E, eb = net.eb, ep = net.ep;
    if (hotSim <= 0.5) return;
    const win = hotEff * 0.4 + hotSim;       // eb/ep carry 40% of the previous window, so the effective window does too
    hotEff = win; hotSim = 0;
    const idx = [];
    const sc = (e) => eb[e] * (ep[e] > 0 ? eb[e] / ep[e] : 0);          // waiting vehicles x share of time spent waiting: long, mostly free-flowing streets rank low
    for (let e = 0; e < E; e++) if (eb[e] / win >= HOT_MIN_Q && eb[e] >= 0.3 * ep[e]) idx.push(e);
    idx.sort((a, b) => sc(b) - sc(a));
    const pick = [], mid = [];
    for (const e of idx) {
      if (pick.length >= HOT_N) break;
      poseAt(e, net.len[e] / 2, 1, 0);
      let ok = true;
      for (const m of mid) if (Math.hypot(m[0] - PX, m[1] - PY) < HOT_MERGE) { ok = false; break; }
      if (ok) { pick.push(e); mid.push([PX, PY]); }
    }
    const slot = new Int16Array(E).fill(-1); pick.forEach((e, k) => { slot[e] = k; });
    const comp = new Int32Array(pick.length * nT), parkedC = new Int32Array(pick.length), cnt = new Int32Array(pick.length);
    for (let i = 0; i < nv; i++) {
      const k = slot[ve[i]]; if (k < 0) continue;
      cnt[k]++; if (vparked[i]) parkedC[k]++; else comp[k * nT + vtype[i]]++;
    }
    const jam = Math.max(0.01, P.jam);
    hot = pick.map((e, k) => {
      const mixv = []; for (let t = 0; t < nT; t++) if (comp[k * nT + t] > 0) mixv.push([t, comp[k * nT + t]]);
      mixv.sort((a, b) => b[1] - a[1]);
      const Ae = net.len[e] * net.ewS[e];
      let goods = 0; for (let t = 0; t < nT; t++) if (GOODS[t]) goods += comp[k * nT + t];
      return { e, nm: net.nm[e], goods, mv: cnt[k] - parkedC[k], x: mid[k][0], y: mid[k][1], q: eb[e] / win, share: ep[e] > 0 ? eb[e] / ep[e] : 0, n: cnt[k], parked: parkedC[k],
               cov: Ae > 0 ? net.occ[e] / Ae / jam : 0, len: net.len[e], w: net.ewS[e], ow: net.ow[e], mix: mixv.slice(0, 4) };
    });
    for (let e = 0; e < E; e++) { eb[e] *= 0.4; ep[e] *= 0.4; }         // exponential memory: recent minutes dominate
    hotV++;
  }

  /* ------------- headless what-if run (own worker; no frames, no real-time loop) ------------- */
  let cancelled = false;
  function runScenario(m) {
    cancelled = false; cancelAt = 0;
    Object.assign(P, m.p.P); Object.assign(C, { on: false }); S.paused = false; S.hidden = false;
    P.jam = Math.max(0.01, P.jam);
    updatePS();
    setupNet(m);
    nv = 0; placed.fill(0); relocN = 0; simT = 0; pgen = 0;
    applyCounts(m.counts);
    const warm = m.warm, total = m.warm + m.meas, id = m.id;
    let measuring = false, rel0 = 0, t0m = 0, nextCov = 0, nextRetry = 2, lastProg = 0;
    function slice() {
      if (cancelled) { post({ type: 'scenarioCancelled', id }); return; }
      const tStart = nowMs();
      try {
        while (simT < total && nowMs() - tStart < 40) {
          if (simT >= nextCov) { refreshCoverage(); nextCov = simT + 2; }
          if (simT >= nextRetry) { fillDeficits(240, 4); nextRetry = simT + 3; }
          if (!measuring && simT >= warm) { measuring = true; acc.steps = acc.mv = acc.blocked = acc.sumV = acc.sumF = 0; rel0 = relocN; t0m = simT; }
          substep(PHYS.maxStep); simT += PHYS.maxStep;
        }
      } catch (err) { post({ type: 'error', message: String(err && err.stack || err) }); return; }
      if (simT < total) {
        if (nowMs() - lastProg > 250) { lastProg = nowMs(); post({ type: 'scenarioProgress', id, frac: simT / total }); }
        setTimeout(slice, 0); return;
      }
      refreshCoverage();
      let wantT = 0, placedT = 0; for (let t = 0; t < nT; t++) { wantT += want[t]; placedT += placed[t]; }
      const st = Math.max(1, acc.steps), mvAvg = acc.mv / st;
      post({ type: 'scenarioResult', id, res: {
        placed: placedT, want: wantT, unfit: wantT - placedT,
        waitPct: mvAvg > 0 ? 100 * (acc.blocked / st) / mvAvg : 0,
        speedPct: acc.sumF > 0 ? 100 * acc.sumV / acc.sumF : 0,
        vkmh: (acc.sumV / st) * 3.6 / 1000,
        relocPer1000PerMin: nv > 0 ? (relocN - rel0) / Math.max(1, simT - t0m) * 60 / (nv / 1000) : 0,
        congKm2: congArea / 1e6,
      } });
    }
    slice();
  }
  let cancelAt = 0;

  /* ------------------------------------ loop -------------------------------- */
  let timer = null, started = false, lastT = 0, simAcc = 0, lastPost = 0, dirty = true;
  let layoutAt = 0, pendCounts = null;

  function tick() {
    const t0 = nowMs();
    const dtReal = lastT ? Math.min(0.1, (t0 - lastT) / 1000) : 0.016;
    lastT = t0;
    if (pendCounts) { const c = pendCounts; pendCounts = null; applyCounts(c); dirty = true; }
    if (layoutAt && t0 - layoutAt > 150) { layoutAt = 0; replaceAll(); dirty = true; }   // debounced: sliders fire often
    if (balance(t0)) { covStale = true; dirty = true; }

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
      winSim += simDone; winReal += dtReal; hotSim += simDone; simT += simDone;
      dirty = true;
      if (t0 - hotAt > 2000) { hotAt = t0; computeHotspots(); }
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
    if (updatePS()) dirty = true;
    S.simSpeed = p.simSpeed; S.paused = !!p.paused; S.hidden = !!p.hidden;
    P.jam = Math.max(0.01, P.jam);
    if (net) {
      if (Math.abs(P.areaKm2 - oldArea) > 1e-9) { GM.applyRoadArea(net, P.areaKm2); layoutAt = nowMs(); }
      if (P.parkStrip !== oldStrip) pgen = (pgen + 1) & 0xffff;
    }
    covStale = true; dirty = true;
  }

  function setupNet(m) {
    net = GM.prepareNetwork(m.raw);
    GM.applyRoadArea(net, P.areaKm2);
    if (m.flow && m.flow.ow && m.flow.ow.length === net.E) { GM.applyFlow(net, m.flow.ow, m.flow.fl); }
    net.pk = new Uint8Array(net.E); if (m.noPark && m.noPark.length === net.E) net.pk.set(m.noPark);
    net.occ = new Float32Array(net.E); net.spdF = new Float32Array(net.E).fill(1);
    net.eb = new Float32Array(net.E); net.ep = new Float32Array(net.E);      // per-street waiting / presence (vehicle-seconds) for hotspot ranking
    setDims(m.dims);
    allocate(); buildGrid(net.bounds);
  }

  function init(m) {
    applyParams(m.p);
    setupNet(m);
    nv = 0; placed.fill(0); relocN = 0; simT = 0;
    applyCounts(m.counts);
    if (!started) { started = true; lastT = 0; timer = setTimeout(loop, 0); }
  }

  function handle(m) {
    try {
      switch (m.cmd) {
        case 'init': init(m); break;
        case 'params': applyParams(m.p); break;
        case 'noPark': setNoPark(m.mask); break;
        case 'streets': setStreets(m.ow, m.fl, m.mask); break;
        case 'counts': pendCounts = m.counts; break;                // latest wins; applied at the next loop iteration
        case 'dims': setDims(m.dims); updateRmax(); layoutAt = nowMs(); dirty = true; break;
        case 'scenario': runScenario(m); break;
        case 'cancel': cancelled = true; break;
        case 'resetRun': relocN = 0; run.events = 0; run.days = 0; markers = []; dirty = true; break;
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
