/* Greater Malé road capacity simulator - page side (UI, drawing, year slider, collision estimate).
 *
 * The simulation itself (street network, non-overlapping placement, movement) runs in worker.js so that
 * the page stays responsive, also on phones. This file sends commands to the worker and draws the
 * position snapshots it sends back. If Web Workers are unavailable it falls back to running the same
 * engine on the page (slower).
 *
 * Files: index.html, shared.js, core.js, worker.js, app.js, data/network.json, data/years.json
 *
 * Collisions are NOT produced by the physics (vehicles never overlap, so they cannot collide). They are a
 * statistical estimate: police accidents x Greater Malé share, scaled by (fleet / 2024 fleet)^beta.
 */
(() => {
'use strict';
const GM = globalThis.GM;
const { TYPES, MAX_VEHICLES } = GM;

/* =====================================================================
 * 1. CONFIG
 * ===================================================================== */
const AREA = { min: 0.80, max: 1.00, step: 0.001, osmnx: 0.894, report: 0.902 };
const DEFAULTS = { parkShare: 0, parkStrip: 2.3, jam: 0.50, simSpeed: 10, dotPx: 2 };
const TODAY_TOTAL = 119093; // Table 3 = the 2024 baseline fleet
const COL = { beta: 1.5, secPerDay: 20, share: 0.8, baseAcc: 2882, baseFleet: 119093 };

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
const counts = new Int32Array(nT);   // requested per type (what the sliders say)
const placed = new Int32Array(nT);   // reported by the worker: actually on the street, never overlapping
const state = {
  areaKm2: AREA.osmnx, parkShare: DEFAULTS.parkShare / 100, parkStrip: DEFAULTS.parkStrip,
  jam: DEFAULTS.jam, simSpeed: DEFAULTS.simSpeed, dotPx: DEFAULTS.dotPx,
  paused: false, heat: true, slow: false, synthetic: false,
  year: 2024, yearCustom: false,
  beta: COL.beta, share: COL.share, secPerDay: COL.secPerDay, colOn: true,
};
let net = null;                      // street geometry for drawing (the worker has its own copy)
let sim = null;                      // {post(msg, transfer), kind}
let frame = null;                    // latest snapshot from the worker
let stats = { mv: 0, parkedN: 0, parkedFP: 0, sumV: 0, sumF: 0, congArea: 0, blockedN: 0 };
let run = { events: 0, days: 0 };
let simRate = 0;
let needDraw = true;
let yearsCfg = null, fit = null;
const markers = [];                  // collision flashes {x, y, t}
const FP = (t) => TYPES[t].L * TYPES[t].W;

/* =====================================================================
 * 3. WORKER LINK
 * ===================================================================== */
function paramsMsg() {
  const A = expectedPerYear(requestedTotal(), state.beta);
  return {
    P: { areaKm2: state.areaKm2, parkShare: state.parkShare, parkStrip: state.parkStrip, jam: state.jam, slow: state.slow },
    C: { on: state.colOn, perDay: A / 365, secPerDay: state.secPerDay },
    simSpeed: state.simSpeed, paused: state.paused, hidden: typeof document !== 'undefined' && !!document.hidden,
  };
}
const pushParams = () => { if (sim) sim.post({ cmd: 'params', p: paramsMsg() }); };
const pushCounts = () => { if (sim) { sim.post({ cmd: 'counts', counts: Array.from(counts) }); pushParams(); } };
const pushDims = () => { if (sim) sim.post({ cmd: 'dims', dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })) }); needDraw = true; };

function onMsg(m) {
  if (m.type === 'frame') onFrame(m);
}

function onFrame(m) {
  const old = frame, n = m.n;
  frame = { buf: m.buf, n, gs: m.gs,
    xs: new Float32Array(m.buf, 0, n), ys: new Float32Array(m.buf, 4 * n, n),
    hx: new Int8Array(m.buf, 8 * n, n), hy: new Int8Array(m.buf, 9 * n, n) };
  if (old && sim) sim.post({ cmd: 'recycle', buf: old.buf }, [old.buf]);   // hand the previous buffer back for reuse
  if (net) net.bkt.set(m.bkt);
  stats = m.stats; run = m.run; simRate = m.simRate;
  for (let t = 0; t < nT; t++) placed[t] = m.placed[t];
  const t0 = now();
  for (const k of m.markers) markers.push({ x: k.x, y: k.y, t: t0 });
  needDraw = true;
}

function localBackend(initMsg, why) {
  const runner = GM.createRunner((msg) => onMsg(msg));
  sim = { post: (m) => runner.handle(m), kind: 'main' };
  const b = $('banner');
  b.style.display = 'block';
  b.innerHTML += (b.innerHTML ? '<br>' : '') + '<b>Web Worker unavailable' + (why ? ' (' + why + ')' : '') + '</b>: the simulation runs on the page and will be slower.';
  sim.post(initMsg);
}

function bootBackend(initMsg) {
  let ready = false;
  try {
    const w = new Worker('worker.js');
    w.onmessage = (e) => { ready = true; onMsg(e.data); };
    w.onerror = (e) => { if (!ready && sim && sim.kind === 'worker') { if (e.preventDefault) e.preventDefault(); localBackend(initMsg, 'worker.js failed to load'); } };
    sim = { post: (m, tr) => w.postMessage(m, tr || []), kind: 'worker' };
    w.postMessage(initMsg);
  } catch (err) {
    localBackend(initMsg, String(err && err.message || err));
  }
}

/* =====================================================================
 * 4. COUNTS (requested fleet) AND STATS HELPERS
 * ===================================================================== */
const requestedTotal = () => { let s = 0; for (let t = 0; t < nT; t++) s += counts[t]; return s; };
const placedTotal = () => { let s = 0; for (let t = 0; t < nT; t++) s += placed[t]; return s; };

function setCount(t, want) {
  want = Math.max(0, Math.floor(Number(want) || 0));
  let others = 0; for (let k = 0; k < nT; k++) if (k !== t) others += counts[k];
  counts[t] = Math.min(want, MAX_VEHICLES - others);
  run = { events: 0, days: 0 };
  pushCounts();
}
function applyCounts(arr) {
  let tot = 0;
  for (let t = 0; t < nT; t++) { counts[t] = Math.max(0, Math.min(Math.floor(arr[t]) || 0, MAX_VEHICLES - tot)); tot += counts[t]; }
  run = { events: 0, days: 0 };
  syncTypeInputs();
  pushCounts();
}
function mixCounts(total) {
  const f = total / TODAY_TOTAL;
  return TYPES.map((t) => Math.round(t.count * f));
}

/* =====================================================================
 * 5. RENDERING (draws the latest snapshot; no physics here)
 * ===================================================================== */
const cv = $('cv'), ctx = cv.getContext('2d');
const view = { w: 800, h: 600, dpr: 1 };
const cam = { x: 0, y: 0, scale: 0.1 };

function resize() {
  const r = cv.getBoundingClientRect();
  view.dpr = Math.min(2, window.devicePixelRatio || 1);   // capped: 3x phone screens cost 2.25x more fill for no visible gain
  view.w = Math.max(100, r.width); view.h = Math.max(100, r.height);
  cv.width = Math.floor(view.w * view.dpr); cv.height = Math.floor(view.h * view.dpr);
  needDraw = true;
}

function fitView() {
  if (!net) return;
  const [x0, y0, x1, y1] = net.bounds;
  cam.x = (x0 + x1) / 2; cam.y = (y0 + y1) / 2;
  cam.scale = Math.min(view.w / (x1 - x0), view.h / (y1 - y0)) * 0.92;
  needDraw = true;
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

  // ---- vehicles (snapshot is grouped by type and parked flag) ----------
  let trueScale = false;
  if (frame) {
    const { xs, ys, hx, hy, gs, n } = frame;
    if (sc >= 3) {                                    // true-scale rectangles only when few are on screen
      let vis = 0;
      for (let i = 0; i < n && vis < 25000; i++) {
        const X = (xs[i] - cx) * sc + hw, Y = hh - (ys[i] - cy) * sc;
        if (X > -6 && X < cw + 6 && Y > -6 && Y < ch + 6) vis++;
      }
      trueScale = vis < 25000;
    }
    const order = TYPES.map((_, i) => i).sort((a, b) => FP(b) - FP(a));   // big first, small on top
    for (const t of order) {
      ctx.fillStyle = TYPES[t].color;
      for (let pk = 0; pk < 2; pk++) {
        const g = t * 2 + pk, a = gs[g], b = gs[g + 1];
        if (b <= a) continue;
        ctx.globalAlpha = pk ? 0.5 : 1;
        if (trueScale) {
          const L = TYPES[t].L, W = TYPES[t].W;
          for (let i = a; i < b; i++) {
            const X = (xs[i] - cx) * sc + hw, Y = hh - (ys[i] - cy) * sc;
            if (X < -20 || X > cw + 20 || Y < -20 || Y > ch + 20) continue;
            const ca = dpr * sc * hx[i] / 127, sa = dpr * sc * hy[i] / 127;
            ctx.setTransform(ca, -sa, sa, ca, dpr * X, dpr * Y);
            ctx.fillRect(-L / 2, -W / 2, L, W);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else {
          const size = Math.max(state.dotPx, Math.sqrt(FP(t)) * sc), half = size / 2;
          for (let i = a; i < b; i++) {
            const X = (xs[i] - cx) * sc + hw, Y = hh - (ys[i] - cy) * sc;
            if (X < -6 || X > cw + 6 || Y < -6 || Y > ch + 6) continue;
            ctx.fillRect(X - half, Y - half, size, size);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

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
 * 6. YEARS
 * ===================================================================== */
const fmt = (x) => Math.round(x).toLocaleString('en-US');
const sumArr = (a) => a.reduce((p, q) => p + q, 0);

function groupIndex(t, yi) {
  const g = yearsCfg.type_group[TYPES[t].id] || 'other';
  return yearsCfg.fleet_index_vs_2024[g].values[yi];
}
const fleetForYearIdx = (yi) => TYPES.map((tp, t) => Math.round(tp.count * groupIndex(t, yi)));

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
  $('scaleRange').value = Math.round(100 * requestedTotal() / TODAY_TOTAL);
  $('scaleOut').textContent = $('scaleRange').value + ' %';
  updateYearUI();
}

function markCustom() { if (!state.yearCustom) { state.yearCustom = true; updateYearUI(); } }

function updateYearUI() {
  if (!yearsCfg) { $('yearStatus').textContent = 'data/years.json not found: year slider disabled.'; return; }
  $('yearRange').value = state.year;
  $('yearOut').textContent = state.year + (state.yearCustom ? ' · edited' : '');
  const yi = yearsCfg.years.indexOf(state.year), r = yearStatusRank(yi);
  const key = ['baseline', 'nbs_shape', 'estimate', 'assumption'][r];
  $('yearStatus').textContent = (state.yearCustom ? 'Fleet edited by hand; collisions use the current fleet. ' : '') + STATUS_TXT[key];
  $('yearStatus').style.color = STATUS_COL[r];
  $('yearFleet').textContent = fmt(requestedTotal()) + ' vehicles';
}

/* =====================================================================
 * 7. COLLISION ESTIMATE  (statistical, see header)
 * ===================================================================== */
const baseAccidents = () => {
  let police = COL.baseAcc;
  if (yearsCfg) { const r = yearsCfg.accidents.series.find((x) => x.year === yearsCfg.baseline.year); if (r) police = r.police; }
  return police * state.share;
};
const baseFleet = () => (yearsCfg ? yearsCfg.baseline.fleet : COL.baseFleet);
function expectedPerYear(N, beta) { return baseAccidents() * Math.pow(N / baseFleet(), beta); }

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

function updateCollisionPanel() {
  const N = requestedTotal(), b = state.beta;
  const A = expectedPerYear(N, b), A0 = baseAccidents(), fleetD = N / baseFleet() * 100 - 100;
  $('colN').textContent = fmt(N) + ' vehicles';
  $('colYr').textContent = fmt(A) + ' / year';
  $('colDay').textContent = (A / 365).toFixed(1) + ' / day';
  $('colPer1k').textContent = N ? (A / N * 1000).toFixed(1) : '–';
  const d = (A / A0 - 1) * 100;
  $('colDelta').textContent = (d >= 0 ? '+' : '') + d.toFixed(0) + ' % (fleet ' + (fleetD >= 0 ? '+' : '') + fleetD.toFixed(0) + ' %)';
  $('colBand').textContent = [1, 1.5, 2].map((x) => 'β ' + x.toFixed(1) + ': ' + fmt(expectedPerYear(N, x))).join('   ·   ');
  let obs = '–';
  if (yearsCfg && !state.yearCustom) {
    const row = yearsCfg.accidents.series.find((r) => r.year === state.year);
    if (row) obs = fmt(row.police * state.share) + (row.status === 'police_full_year' ? '' : ' (estimate)');
  }
  $('colObs').textContent = obs;
  const ev = run.events, dy = run.days;
  $('colRun').textContent = ev + ' in ' + dy.toFixed(1) + ' sim. days' +
    (dy >= 1 ? '  →  ' + fmt(ev / dy * 365) + ' / yr (±' + fmt(Math.sqrt(Math.max(ev, 1)) / dy * 365) + ')' : '');
  $('betaOut').textContent = b.toFixed(2);
  if (fit) $('betaFit').textContent = 'Fit 2021–25: β ≈ ' + fit.beta.toFixed(2);
  drawAccChart();
}

function drawAccChart() {
  const c = $('accCv');
  if (!c || !yearsCfg || typeof c.clientWidth !== 'number') return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 340, h = 150;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const yrs = yearsCfg.years, nY = yrs.length, pl = 38, pr = 8, pt = 10, pb = 22;
  const obs = yrs.map((y) => { const r = yearsCfg.accidents.series.find((q) => q.year === y); return r ? r.police * state.share : 0; });
  const Ny = yrs.map((_, yi) => sumArr(fleetForYearIdx(yi)));
  const curve = (b) => Ny.map((N) => expectedPerYear(N, b));
  const cSel = curve(state.beta), c1 = curve(1), c2 = curve(2);
  const ymax = Math.max(...obs, ...cSel, ...c2) * 1.08;
  const X = (i) => pl + (i + 0.5) * (w - pl - pr) / nY, Y = (v) => pt + (1 - v / ymax) * (h - pt - pb);
  const bw = (w - pl - pr) / nY * 0.5;
  g.font = '10px system-ui,sans-serif'; g.textAlign = 'right'; g.fillStyle = '#8b98a8'; g.strokeStyle = '#2a3441'; g.lineWidth = 1;
  for (let k = 0; k <= 2; k++) {
    const v = ymax * k / 2; g.beginPath(); g.moveTo(pl, Y(v)); g.lineTo(w - pr, Y(v)); g.stroke();
    g.fillText(fmt(v), pl - 4, Y(v) + 3);
  }
  g.textAlign = 'center';
  yrs.forEach((y, i) => {
    const cur = !state.yearCustom && y === state.year;
    g.fillStyle = cur ? '#ffffff' : '#8b98a8'; g.fillText(String(y), X(i), h - 8);
    const est = (yearsCfg.accidents.series.find((q) => q.year === y) || {}).status !== 'police_full_year';
    if (est) { g.strokeStyle = '#3fb6ff'; g.setLineDash([3, 2]); g.strokeRect(X(i) - bw / 2, Y(obs[i]), bw, Y(0) - Y(obs[i])); g.setLineDash([]); }
    else { g.fillStyle = cur ? '#7fd0ff' : '#2b8fd0'; g.fillRect(X(i) - bw / 2, Y(obs[i]), bw, Y(0) - Y(obs[i])); }
  });
  const line = (arr, col, dash, width, dots) => {
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = width; g.setLineDash(dash);
    g.beginPath(); arr.forEach((v, i) => { if (i) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v)); }); g.stroke(); g.setLineDash([]);
    if (dots) arr.forEach((v, i) => { g.beginPath(); g.arc(X(i), Y(v), 3, 0, Math.PI * 2); g.fill(); });
  };
  line(c1, '#6b7788', [4, 3], 1, false); line(c2, '#6b7788', [4, 3], 1, false);
  line(cSel, '#ffa62b', [], 2, true);
}

/* =====================================================================
 * 8. UI
 * ===================================================================== */
function buildTypeRows() {
  const box = $('types'); box.innerHTML = '';
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
  const rows = $('types').children;
  for (let i = 0; i < rows.length; i++) { rows[i]._num.value = counts[i]; rows[i]._rng.value = counts[i]; }
}

function buildDims() {
  const tb = $('dims');
  tb.innerHTML = '<tr><th>Type</th><th>L (m)</th><th>W (m)</th><th>km/h</th></tr>';
  TYPES.forEach((t) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t.name}</td>
      <td><input type="number" step="0.1" min="0.3" value="${t.L}" data-k="L"></td>
      <td><input type="number" step="0.1" min="0.3" value="${t.W}" data-k="W"></td>
      <td><input type="number" step="1" min="1" value="${(t.v * 3.6).toFixed(0)}" data-k="v"></td>`;
    tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const val = parseFloat(inp.value); if (!(val > 0)) return;
      const k = inp.dataset.k;
      if (k === 'v') t.v = val / 3.6; else t[k] = val;
      pushDims();
    }));
    tb.appendChild(tr);
  });
}

function bindUI() {
  // road area
  const ar = $('areaRange');
  ar.min = AREA.min; ar.max = AREA.max; ar.step = AREA.step; ar.value = state.areaKm2;
  const setArea = (v) => {
    state.areaKm2 = Math.min(AREA.max, Math.max(AREA.min, v)); ar.value = state.areaKm2;
    $('areaOut').textContent = state.areaKm2.toFixed(3) + ' km²';
    if (net) GM.applyRoadArea(net, state.areaKm2);
    pushParams(); needDraw = true;
  };
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
      markCustom();
    });
    pb.appendChild(b);
  });
  $('scaleRange').addEventListener('input', (ev) => {
    const pct = parseFloat(ev.target.value); $('scaleOut').textContent = pct + ' %';
    applyCounts(mixCounts(TODAY_TOTAL * pct / 100)); markCustom();
  });

  // year + collision model
  $('yearRange').addEventListener('input', (ev) => applyYear(parseInt(ev.target.value, 10)));
  const setBeta = (b) => { state.beta = Math.min(2.5, Math.max(1, b)); $('betaRange').value = state.beta; pushParams(); updateCollisionPanel(); };
  $('betaRange').addEventListener('input', (ev) => setBeta(parseFloat(ev.target.value)));
  $('beta1').addEventListener('click', () => setBeta(1));
  $('beta15').addEventListener('click', () => setBeta(1.5));
  $('beta2').addEventListener('click', () => setBeta(2));
  $('betaFit').addEventListener('click', () => { if (fit) setBeta(fit.beta); });
  $('shareNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0 && v <= 100) { state.share = v / 100; pushParams(); updateCollisionPanel(); } });
  $('colChk').addEventListener('change', (ev) => { state.colOn = ev.target.checked; pushParams(); });
  $('secDayRange').addEventListener('input', (ev) => { state.secPerDay = parseFloat(ev.target.value); $('secDayOut').textContent = state.secPerDay + ' s'; pushParams(); });
  $('colReset').addEventListener('click', () => { run = { events: 0, days: 0 }; markers.length = 0; if (sim) sim.post({ cmd: 'resetRun' }); needDraw = true; });

  // parking & movement
  $('parkRange').addEventListener('input', (ev) => { state.parkShare = ev.target.value / 100; $('parkOut').textContent = ev.target.value + ' %'; pushParams(); });
  $('stripNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0) { state.parkStrip = v; pushParams(); } });
  $('jamRange').addEventListener('input', (ev) => { state.jam = ev.target.value / 100; $('jamOut').textContent = ev.target.value + ' %'; pushParams(); });
  $('speedSel').addEventListener('change', (ev) => { state.simSpeed = parseFloat(ev.target.value); pushParams(); });
  $('pauseBtn').addEventListener('click', (ev) => { state.paused = !state.paused; ev.target.textContent = state.paused ? 'Resume' : 'Pause'; pushParams(); });
  $('dotRange').addEventListener('input', (ev) => { state.dotPx = parseFloat(ev.target.value); $('dotOut').textContent = state.dotPx.toFixed(1) + ' px'; needDraw = true; });
  $('heatChk').addEventListener('change', (ev) => { state.heat = ev.target.checked; needDraw = true; });
  $('slowChk').addEventListener('change', (ev) => { state.slow = ev.target.checked; pushParams(); });
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', pushParams);   // pause the worker in background tabs

  // camera
  const zoomAt = (mx, my, f) => {
    const wx = (mx - view.w / 2) / cam.scale + cam.x, wy = cam.y - (my - view.h / 2) / cam.scale;
    cam.scale = Math.min(60, Math.max(0.02, cam.scale * f));
    cam.x = wx - (mx - view.w / 2) / cam.scale; cam.y = wy + (my - view.h / 2) / cam.scale;
    needDraw = true;
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
    if (ptrs.size === 1) { cam.x -= dx / cam.scale; cam.y += dy / cam.scale; needDraw = true; }
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

function updateStats() {
  const areaM2 = state.areaKm2 * 1e6;
  let foot = 0;
  for (let t = 0; t < nT; t++) foot += placed[t] * FP(t);     // only vehicles that fit are on the street
  const total = placedTotal(), req = requestedTotal();
  const pct = foot / areaM2;
  const jam = state.jam;
  $('sArea').textContent = state.areaKm2.toFixed(3) + ' km²';
  $('sFoot').textContent = (foot / 1e6).toFixed(3) + ' km²  (' + fmt(foot) + ' m²)';
  $('sPct').textContent = (pct * 100).toFixed(1) + ' %';
  $('sParkFoot').textContent = (stats.parkedFP / areaM2 * 100).toFixed(1) + ' %';
  $('sVeh').textContent = fmt(total) + '  (' + fmt(stats.mv) + ' / ' + fmt(stats.parkedN) + ')';
  const unfit = req - total;
  $('sPlaced').textContent = unfit > 0 ? fmt(total) + ' of ' + fmt(req) + ' · ' + fmt(unfit) + ' do not fit' : fmt(total) + ' of ' + fmt(req);
  $('sPlaced').style.color = unfit > 0 ? '#f85149' : '';
  $('sBlocked').textContent = stats.mv ? (stats.blockedN / stats.mv * 100).toFixed(0) + ' % waiting' : '–';
  const kmh = stats.mv ? stats.sumV / stats.mv * 3.6 : 0;
  const rel = stats.sumF ? stats.sumV / stats.sumF * 100 : 100;
  $('sSpeed').textContent = stats.mv ? kmh.toFixed(1) + ' km/h  (' + rel.toFixed(0) + ' % of free-flow)' : '–';
  $('sRate').textContent = state.paused ? 'paused' : simRate.toFixed(1) + '× real time (selected ' + state.simSpeed + '×)';
  $('sCong').textContent = (stats.congArea / areaM2 * 100).toFixed(1) + ' %';
  const meanFP = total ? foot / total : 0;
  $('sCeil').textContent = meanFP ? '≈ ' + fmt(jam * areaM2 / meanFP) + ' vehicles' : '–';
  const fill = $('barFill');
  fill.style.width = Math.min(100, pct * 100) + '%';
  const ratio = pct / jam;
  fill.style.background = ratio < 0.6 ? '#3fb950' : ratio < 1 ? '#e3a008' : '#f85149';
  $('barMark').style.left = (jam * 100) + '%';
  $('barMarkLbl').textContent = 'packing limit ' + Math.round(jam * 100) + ' %';
  if (yearsCfg) $('yearFleet').textContent = fmt(req) + ' vehicles';
  updateCollisionPanel();
}

/* =====================================================================
 * 9. MAIN LOOP (drawing only when something changed)
 * ===================================================================== */
let lastStatsT = 0;
function raf(t) {
  if (needDraw || markers.length) { needDraw = false; draw(); }
  if (t - lastStatsT > 250) { lastStatsT = t; updateStats(); }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(raf);
}

async function loadJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (err) { return null; }
}

async function init() {
  buildTypeRows(); buildDims(); bindUI();
  resize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { resize(); }).observe(cv.parentElement);
  const [rawNet, years] = await Promise.all([loadJson('data/network.json'), loadJson('data/years.json')]);
  const raw = rawNet || GM.makeSyntheticNetwork();
  state.synthetic = !rawNet;
  if (state.synthetic) {
    const b = $('banner'); b.style.display = 'block';
    b.innerHTML = 'Showing a <b>placeholder network</b> because <code>data/network.json</code> was not found. ' +
      'Run <code>python tools/export_network.py</code> to build the real Greater Malé streets. ' +
      '(Opening index.html straight from disk also blocks loading — use <code>python -m http.server</code>.)';
  }
  net = GM.prepareNetwork(raw);
  GM.applyRoadArea(net, state.areaKm2);

  yearsCfg = years;
  if (yearsCfg) {
    fit = computeFit();
    const yr = $('yearRange');
    yr.min = yearsCfg.years[0]; yr.max = yearsCfg.years[yearsCfg.years.length - 1]; yr.step = 1;
    state.year = yearsCfg.baseline.year;
    const sh = yearsCfg.accidents.greater_male_share; if (sh > 0) { state.share = sh; $('shareNum').value = Math.round(sh * 100); }
    state.beta = yearsCfg.model.beta_default || COL.beta; $('betaRange').value = state.beta;
  } else { $('yearRange').disabled = true; }

  TYPES.forEach((t, i) => { counts[i] = t.count; });
  syncTypeInputs();
  fitView();
  updateYearUI();
  bootBackend({ cmd: 'init', raw, dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })), p: paramsMsg(), counts: Array.from(counts) });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(raf);
}

window.TrafficSim = { state, counts, placed, TYPES, setCount, applyCounts, mixCounts, applyYear, expectedPerYear,
  draw, updateStats, fitView, fleetForYearIdx,
  get net() { return net; }, get frame() { return frame; }, get stats() { return stats; }, get run() { return run; },
  get years() { return yearsCfg; }, get fit() { return fit; }, get sim() { return sim; }, get simRate() { return simRate; } };
init();
})();
