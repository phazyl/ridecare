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
const DEFAULTS = { parkShare: 89, parkStrip: 2.3, jam: 0.50, patience: 5, simSpeed: 1, dotPx: 2 };
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
  safe: false, react: 1.5, mu: 0.6,
  jam: DEFAULTS.jam, patience: DEFAULTS.patience, simSpeed: DEFAULTS.simSpeed, dotPx: DEFAULTS.dotPx,
  paused: false, heat: true, slow: false, synthetic: false,
  year: 2024, yearCustom: false, advBusy: false,
  beta: COL.beta, share: COL.share, secPerDay: COL.secPerDay, colOn: true, showHot: true,
};
let net = null;                      // street geometry for drawing (the worker has its own copy)
let sim = null;                      // {post(msg, transfer), kind}
let frame = null;                    // latest snapshot from the worker
let stats = { mv: 0, parkedN: 0, parkedFP: 0, sumV: 0, sumF: 0, congArea: 0, blockedN: 0 };
let run = { events: 0, days: 0 };
let simRate = 0;
let needDraw = true;
let yearsCfg = null, fit = null;
let hot = [], hotDirty = false, rawNetwork = null;   // advisor: live hotspots from the worker, raw street data for what-if runs
const markers = [];                  // collision flashes {x, y, t}
const FP = (t) => TYPES[t].L * TYPES[t].W;

/* =====================================================================
 * 3. WORKER LINK
 * ===================================================================== */
function paramsMsg() {
  const A = expectedPerYear(requestedTotal(), state.beta);
  return {
    P: { areaKm2: state.areaKm2, parkShare: state.parkShare, parkShareT: clkParkArr(), parkStrip: state.parkStrip, jam: state.jam, slow: state.slow, patience: state.patience, safe: state.safe, react: state.react, mu: state.mu },
    C: { on: state.colOn, perDay: A / 365 * clkExposure(), secPerDay: clkSecPerDay() },
    simSpeed: state.simSpeed, paused: state.paused || state.advBusy, hidden: typeof document !== 'undefined' && !!document.hidden,
  };
}
const pushParams = () => { if (sim) sim.post({ cmd: 'params', p: paramsMsg() }); };
const pushCounts = () => { if (sim) { sim.post({ cmd: 'counts', counts: Array.from(counts) }); pushParams(); } };
const pushDims = () => { if (sim) sim.post({ cmd: 'dims', dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })) }); needDraw = true; };

function onMsg(m) {
  if (m.type === 'frame') onFrame(m);
  else if (m.type === 'error') {
    if (typeof console !== 'undefined') console.error(m.message);
    const b = $('banner'); b.style.display = 'block'; b.textContent = 'Simulation error: ' + String(m.message).split('\n')[0];
  }
}

function onFrame(m) {
  const old = frame, n = m.n;
  frame = { buf: m.buf, n, gs: m.gs,
    xs: new Float32Array(m.buf, 0, n), ys: new Float32Array(m.buf, 4 * n, n),
    hx: new Int8Array(m.buf, 8 * n, n), hy: new Int8Array(m.buf, 9 * n, n) };
  if (old && sim) sim.post({ cmd: 'recycle', buf: old.buf }, [old.buf]);   // hand the previous buffer back for reuse
  if (net) net.bkt.set(m.bkt);
  stats = m.stats; run = m.run; simRate = m.simRate;
  if (m.hot) { hot = m.hot; hotDirty = true; }
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

  // ---- closed kerbs and the selected street ----------------------------------
  if (NP.pk) drawNp(sc, cx, cy, hw, hh);

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

  // ---- advisor hotspots --------------------------------------------------
  if (state.showHot && hot.length) {
    ctx.lineWidth = 2.5;
    hot.forEach((h, k) => {
      const X = (h.x - cx) * sc + hw, Y = hh - (h.y - cy) * sc;
      if (X < -60 || X > cw + 60 || Y < -60 || Y > ch + 60) return;
      const col = hotColor(h), r = Math.max(14, Math.min(46, 6 + Math.sqrt(h.q) * 1.1));
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.12; ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = '#0d1117'; ctx.beginPath(); ctx.arc(X, Y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.font = 'bold 11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(k + 1), X, Y + 0.5); ctx.textBaseline = 'alphabetic';
      const nm = hotName(h);
      if (nm && sc >= 0.2) {                                            // street name under the ring once zoomed in a little
        ctx.font = '600 12px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#0d1117';
        ctx.strokeText(nm, X, Y + r + 14); ctx.fillStyle = '#e6edf3'; ctx.fillText(nm, X, Y + r + 14); ctx.lineWidth = 2.5; ctx.strokeStyle = col;
      }
      ctx.textAlign = 'left';
    });
  }

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
 * 6b. TIME OF DAY  (year -> day of week -> time; sets the moving / parked split)
 *   moving share of a type = peak_share[type] x curve(time); parked share = 1 - moving share.
 *   Figures come from the IUM report (Tables 30, 31); the curve shape between the report's peak windows is an assumption.
 * ===================================================================== */
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLK = { on: true, live: true, day: 1, min: 465, play: false, spdH: 2, curves: null, last: 0, lastPush: 0, liveT: 0, usage: null };
const dayKey = (d) => { const dt = CLK.usage.day_types; return Object.keys(dt).find((k) => dt[k].days.includes(d)) || 'weekday'; };

function clkBuild(usage) {
  CLK.usage = usage; CLK.curves = {};
  const keys = Object.keys(usage.day_types), N = 96;
  let refArea = 0;
  for (const k of keys) {
    const kf = usage.day_types[k].curve, v = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const h = (i + 0.5) / 4; let j = 1;
      while (j < kf.length - 1 && kf[j][0] < h) j++;
      const a = kf[j - 1], b = kf[j], f = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0])));
      v[i] = a[1] + (b[1] - a[1]) * f;
    }
    let area = 0; for (let i = 0; i < N; i++) area += v[i];
    CLK.curves[k] = { v, area };
    if (k === 'weekday') refArea = area;
  }
  for (const k of keys) {                  // weekly = 7 x daily in the report: every day has the same daily volume
    const c = CLK.curves[k], f = refArea / c.area;
    if (k !== 'weekday') for (let i = 0; i < N; i++) c.v[i] *= f;
    c.mean = refArea / N;
  }
}
const clkOn = () => CLK.on && !!CLK.curves;
const clkCurve = () => CLK.curves[dayKey(CLK.day)];
const clkLevel = () => clkCurve().v[Math.min(95, Math.floor(CLK.min / 15))];
function clkPeak(t) { const p = CLK.usage.peak_share; const v = p.by_type[TYPES[t].id]; return v != null ? v : p.default; }
const clkMoveShare = (t) => Math.min(1, clkPeak(t) * clkLevel());
function clkParkArr() { return clkOn() ? TYPES.map((_, t) => 1 - clkMoveShare(t)) : null; }
const clkExposure = () => (clkOn() ? clkLevel() / clkCurve().mean : 1);
const clkSecPerDay = () => (clkOn() && CLK.play ? 24 * CLK.spdH : clkOn() && CLK.live ? 86400 / Math.max(1, state.simSpeed) : state.secPerDay);
// Current day and time in the Maldives (UTC+5, no daylight saving)
function mvNow() {
  try {
    const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'Indian/Maldives', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    const d = DAYN.indexOf(p.weekday); if (d >= 0) return { day: d, min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
  } catch (err) { /* fall through */ }
  const t = new Date(Date.now() + 5 * 3600e3); return { day: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function clkSyncLive() { const n = mvNow(), ch = n.day !== CLK.day || Math.floor(n.min) !== Math.floor(CLK.min); CLK.day = n.day; CLK.min = n.min; return ch; }
function clkTotals() {
  let tot = 0, mv = 0;
  for (let t = 0; t < nT; t++) { tot += counts[t]; mv += counts[t] * (clkOn() ? clkMoveShare(t) : 1 - state.parkShare); }
  return { tot, mv, pk: tot - mv };
}
const clkFmtTime = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');
function clkPeriod() {
  const h = CLK.min / 60, pk = CLK.usage.day_types[dayKey(CLK.day)].peaks.find((p) => h >= p[0] && h < p[1]);
  return pk ? pk[2] : (h < 5.5 || h >= 22 ? 'Night' : 'Off-peak');
}
function clkDraw() {
  const cv = $('clkCv'); if (!cv || !CLK.curves) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const k = dayKey(CLK.day), c = CLK.curves[k], pad = 4, ph = H - 16;
  const X = (h) => pad + (W - 2 * pad) * h / 24, Y = (lv) => 4 + ph * (1 - Math.min(1.1, lv) / 1.1);
  g.fillStyle = 'rgba(63,182,255,.16)';
  for (const p of CLK.usage.day_types[k].peaks) g.fillRect(X(p[0]), 2, X(p[1]) - X(p[0]), ph + 2);
  g.strokeStyle = '#2a3441'; g.fillStyle = '#8b98a8'; g.font = '10px system-ui'; g.lineWidth = 1;
  for (let h = 0; h <= 24; h += 6) { g.beginPath(); g.moveTo(X(h), 2); g.lineTo(X(h), ph + 4); g.stroke(); g.fillText(String(h).padStart(2, '0'), Math.min(X(h), W - 14), H - 3); }
  g.beginPath(); for (let i = 0; i < 96; i++) { const x = X((i + 0.5) / 4), y = Y(c.v[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = '#3fb6ff'; g.lineWidth = 2; g.stroke();
  const mx = X(CLK.min / 60); g.strokeStyle = '#f2cc60'; g.lineWidth = 2; g.beginPath(); g.moveTo(mx, 2); g.lineTo(mx, ph + 4); g.stroke();
  g.fillStyle = '#f2cc60'; g.beginPath(); g.arc(mx, Y(clkLevel()), 4, 0, 7); g.fill();
}
function clkUI() {
  if (!CLK.curves) return;
  const on = clkOn();
  $('clkBox').classList.toggle('off', !on);
  $('parkRange').disabled = on;
  $('parkLbl').textContent = on ? 'Share of vehicles parked (set by the clock)' : 'Share of vehicles parked';
  document.querySelectorAll('#dayChips button').forEach((b, i) => b.classList.toggle('on', i === CLK.day));
  $('clkRange').value = Math.floor(CLK.min);
  $('clkOut').textContent = clkFmtTime(CLK.min);
  $('clkPlay').textContent = CLK.play ? '❚❚ Pause clock' : '▶ Play day';
  $('clkLive').classList.toggle('on', CLK.live);
  const T = clkTotals(), pc = (x) => (T.tot ? (100 * x / T.tot).toFixed(1) : '0') + ' %';
  if (on) {
    $('parkOut').textContent = pc(T.pk); $('parkRange').value = Math.round(100 * (T.tot ? T.pk / T.tot : 0));
    $('clkRead').innerHTML = `<b>${DAYN[CLK.day]} ${clkFmtTime(CLK.min)}</b>${CLK.live ? ' <span style="color:#3fb950">● live, Maldives time</span>' : ''} · ${clkPeriod()}<br>` +
      `<span style="color:#3fb950">${fmt(T.mv)} moving (${pc(T.mv)})</span> · <span style="color:#e3a008">${fmt(T.pk)} parked (${pc(T.pk)})</span>`;
    const dk = dayKey(CLK.day), rep = CLK.usage.report_figures;
    $('clkNote').textContent = `Report: ${fmt(rep.hourly_total)} vehicles active in a peak hour (${(100 * CLK.usage.peak_share.default).toFixed(1)} % of the fleet), ${fmt(rep.daily_total)} per day. ` +
      (dk === 'weekday' ? 'Peak windows are from the report; the curve between them is an estimate.' : 'The report gives no ' + DAYN[CLK.day] + ' data: peak windows and curve are assumptions, with the same daily volume as a weekday.');
  } else { $('clkRead').textContent = 'Time of day is off: the parked-share slider below is in control.'; $('clkNote').textContent = ''; }
  clkDraw();
}
function clkApply(push) { clkUI(); if (push) { CLK.lastPush = now(); pushParams(); } }
function clkTick(t) {
  if (CLK.live && clkOn() && t - CLK.liveT > 5000) { CLK.liveT = t; if (clkSyncLive()) clkApply(true); }
  if (!CLK.play || !clkOn() || state.paused) { CLK.last = t; return; }
  const dt = Math.min(0.25, (t - CLK.last) / 1000); CLK.last = t;
  CLK.min += dt * 60 / CLK.spdH;
  if (CLK.min >= 1440) { CLK.min -= 1440; CLK.day = (CLK.day + 1) % 7; }
  clkUI();
  if (now() - CLK.lastPush > 100) { CLK.lastPush = now(); pushParams(); }
}
function clkBind() {
  const chips = $('dayChips');
  DAYN.forEach((n, i) => {
    const b = document.createElement('button'); b.textContent = n; b.className = (dayKey(i) !== 'weekday') ? 'we' : '';
    b.addEventListener('click', () => { CLK.live = false; CLK.day = i; clkApply(true); }); chips.appendChild(b);
  });
  $('clkOn').addEventListener('change', (ev) => { CLK.on = ev.target.checked; if (!CLK.on) CLK.play = false; clkApply(true); });
  $('clkRange').addEventListener('input', (ev) => { CLK.live = false; CLK.min = +ev.target.value; clkApply(true); });
  $('clkLive').addEventListener('click', () => { CLK.live = true; CLK.play = false; clkSyncLive(); clkApply(true); });
  $('clkPlay').addEventListener('click', () => { CLK.live = false; CLK.play = !CLK.play; CLK.last = now(); clkApply(true); });
  $('clkSpd').addEventListener('change', (ev) => { CLK.spdH = +ev.target.value; pushParams(); });
  const cv = $('clkCv'); let drag = false;
  const at = (ev) => { CLK.live = false; const r = cv.getBoundingClientRect(); CLK.min = Math.max(0, Math.min(1439, Math.round((ev.clientX - r.left) / r.width * 1440 / 5) * 5)); clkApply(true); };
  cv.addEventListener('pointerdown', (ev) => { drag = true; try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } at(ev); });
  cv.addEventListener('pointermove', (ev) => { if (drag) at(ev); });
  cv.addEventListener('pointerup', () => { drag = false; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(clkDraw).observe(cv);
}


/* =====================================================================
 * 6c. NO-PARKING STREETS
 *   NP.pk[e]: bit 1 = left kerb closed, bit 2 = right kerb closed ("left" = left of the street's drawing direction u -> v).
 *   Default: Boduthakurufaanu Magu (OSM also uses this name for the Malé-Hulhumalé bridge) and the bridge itself are closed on both kerbs.
 *   The rules are kept in this browser (localStorage) and are tied to the network file they were made for.
 * ===================================================================== */
const NP = { names: ['Boduthakurufaanu Magu', 'Sinamalé Bridge'], pk: null, list: [], sel: null, all: false, key: 'gm_streets_v2' };
const npName = (e) => (net.nm[e] >= 0 ? net.names[net.nm[e]] : null);
function npDefault() {
  const pk = new Uint8Array(net.E), ids = NP.names.map((n) => net.names.indexOf(n)).filter((i) => i >= 0), ends = [];
  const endPts = (e) => { const o = net.off[e], q = net.off[e + 1] - 1; return [[net.px[o], net.py[o]], [net.px[q], net.py[q]]]; };
  for (let e = 0; e < net.E; e++) if (ids.includes(net.nm[e])) { pk[e] = 3; if (net.len[e] > 1000) ends.push(...endPts(e)); }
  // the bridge's other carriageway: long segments whose two ends lie within 150 m of those bridge ends
  const near = (p) => ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 150);
  for (let e = 0; e < net.E; e++) if (!pk[e] && net.len[e] > 1000 && endPts(e).every(near)) pk[e] = 3;
  return pk;
}
const npGen = () => rawNetwork && rawNetwork.meta && rawNetwork.meta.generated;
function npStored() {
  try { const o = JSON.parse(localStorage.getItem(NP.key) || 'null'); if (o && o.n === net.E && o.gen === npGen()) return o; } catch (err) { /* storage unavailable */ }
  return null;
}
function npLoadFlow() {                                    // street directions saved in this browser (applied before kerb rules)
  const o = npStored(); if (!o || !Array.isArray(o.f)) return;
  const ow = net.ow.slice(), fl = net.fl.slice();
  for (const [e, a, f] of o.f) if (e >= 0 && e < net.E) { ow[e] = a ? 1 : 0; fl[e] = f ? 1 : 0; }
  GM.applyFlow(net, ow, fl);
}
function npLoad() {
  const o = npStored();
  if (o && Array.isArray(o.b)) { const pk = new Uint8Array(net.E); for (const [e, m] of o.b) if (e >= 0 && e < net.E) pk[e] = m & 3; return pk; }
  return npDefault();
}
function npSave() {
  try {
    const b = [], f = [];
    for (let e = 0; e < net.E; e++) { if (NP.pk[e]) b.push([e, NP.pk[e]]); if (net.ow[e] !== net.ow0[e] || net.fl[e]) f.push([e, net.ow[e], net.fl[e]]); }
    localStorage.setItem(NP.key, JSON.stringify({ gen: npGen(), n: net.E, b, f }));
  } catch (err) { /* ignore */ }
}
const pushNp = () => { if (sim && NP.pk) sim.post({ cmd: 'noPark', mask: Array.from(NP.pk) }); };
function npRefresh(push) {
  NP.list = []; let closed = 0, all = 0;
  for (let e = 0; e < net.E; e++) {
    all += 2 * net.len[e];
    const m = NP.pk[e]; if (!m) continue;
    NP.list.push(e); closed += net.len[e] * ((m & 1) + ((m >> 1) & 1));
  }
  $('npSummary').textContent = NP.list.length
    ? NP.list.length + ' street segments restricted · ' + (closed / 1000).toFixed(1) + ' km of kerb closed (' + (100 * closed / all).toFixed(1) + ' % of all kerb)'
    : 'Parking is allowed on every street.';
  dirSummary(); npUpdateSel(); needDraw = true;
  if (push) { npSave(); pushNp(); }
}
function dirSummary() {
  let ow = 0, tw = 0, edited = 0, trap = 0;
  const inc = new Uint8Array(net.N);
  for (let e = 0; e < net.E; e++) { if (net.ow[e]) { ow++; inc[net.v[e]] = 1; } else { tw++; inc[net.u[e]] = 1; inc[net.v[e]] = 1; } if (net.ow[e] !== net.ow0[e] || net.fl[e]) edited++; }
  for (let e = 0; e < net.E; e++) if (net.ow[e]) { const v = net.v[e]; if (net.adjOff[v + 1] === net.adjOff[v]) trap++; else if (!inc[net.u[e]]) trap++; }
  $('dirSummary').innerHTML = `${ow} one-way and ${tw} two-way segments` + (edited ? ` · <b>${edited} changed by you</b>` : '') +
    (trap ? `<br><span style="color:#e3a008">⚠ ${trap} one-way segment${trap === 1 ? '' : 's'} lead into a dead end or cannot be entered; vehicles there wait and are then relocated.</span>` : '');
}
const COMP = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
function origVec(e) {                                       // direction of the street as in the file (u -> v), in map coordinates
  const o = net.off[e], q = net.off[e + 1] - 1, s = net.fl[e] ? -1 : 1;
  return [s * (net.px[q] - net.px[o]), s * (net.py[q] - net.py[o])];
}
const compass = (v) => COMP[Math.round(((Math.atan2(v[0], v[1]) * 180 / Math.PI + 360) % 360) / 45) % 8];
function setDirection(mode) {                              // 0 two-way, 1 one-way along the file's direction, 2 against it
  if (NP.sel == null) return;
  const ow = net.ow.slice(), fl = net.fl.slice(), D = origVec(NP.sel).map((x) => (mode === 2 ? -x : x));
  for (const e of npSelEdges()) {
    if (mode === 0) { ow[e] = 0; continue; }
    const v = origVec(e); ow[e] = 1; fl[e] = v[0] * D[0] + v[1] * D[1] >= 0 ? 0 : 1;
  }
  applyStreets(ow, fl);
}
function applyStreets(ow, fl) {
  for (let e = 0; e < net.E; e++) if ((fl[e] ? 1 : 0) !== net.fl[e]) { const m = NP.pk[e]; NP.pk[e] = ((m & 1) << 1) | ((m >> 1) & 1); }   // same physical kerb after a reversal
  GM.applyFlow(net, ow, fl);
  if (sim) sim.post({ cmd: 'streets', ow: Array.from(ow), fl: Array.from(fl), mask: Array.from(NP.pk) });
  npRefresh(false); npSave();
}
function npSelEdges() {
  if (NP.sel == null) return [];
  const n = net.nm[NP.sel];
  if (!NP.all || n < 0) return [NP.sel];
  const out = []; for (let e = 0; e < net.E; e++) if (net.nm[e] === n) out.push(e);
  return out;
}
function npUpdateSel() {
  const box = $('npSel');
  if (NP.sel == null) { box.hidden = true; return; }
  box.hidden = false;
  const e = NP.sel, nm = npName(e), edges = npSelEdges(); let len = 0; for (const k of edges) len += net.len[k];
  $('npSelName').textContent = nm || 'Unnamed street';
  $('npSelInfo').textContent = edges.length + ' segment' + (edges.length === 1 ? '' : 's') + ' · ' + Math.round(len) + ' m · ' + net.ewS[e].toFixed(1) + ' m wide' + (net.ow[e] ? ' · one-way' : ' · two-way');
  const dv = origVec(e), A = compass(dv), B = compass([-dv[0], -dv[1]]), ds = $('dirSel');
  ds.options[1].textContent = 'One-way, towards ' + A; ds.options[2].textContent = 'One-way, towards ' + B;
  ds.value = net.ow[e] ? (net.fl[e] ? '2' : '1') : '0';
  $('npL').checked = !(NP.pk[e] & 1); $('npR').checked = !(NP.pk[e] & 2);
  let same = 0; if (nm) for (let k = 0; k < net.E; k++) if (net.nm[k] === net.nm[e]) same++;
  $('npAll').checked = NP.all && same > 0; $('npAll').disabled = !nm || same < 2;
  $('npAllTxt').textContent = nm && same > 1 ? 'Apply to all ' + same + ' segments named “' + nm + '”' : 'Only this segment (no other segment has this name)';
}
function npSetSide(bit, allowed) {
  for (const e of npSelEdges()) NP.pk[e] = allowed ? NP.pk[e] & ~bit : NP.pk[e] | bit;
  npRefresh(true);
}
function npHit(mx, my) {
  const wx = (mx - view.w / 2) / cam.scale + cam.x, wy = cam.y - (my - view.h / 2) / cam.scale, tol = 10 / cam.scale;
  let best = -1, bd = Infinity;
  for (let e = 0; e < net.E; e++) {
    const m = tol + net.ewS[e] / 2;
    if (wx < net.bx0[e] - m || wx > net.bx1[e] + m || wy < net.by0[e] - m || wy > net.by1[e] + m) continue;
    let d = Infinity;
    for (let k = net.off[e]; k < net.off[e + 1] - 1; k++) {
      const x0 = net.px[k], y0 = net.py[k], dx = net.px[k + 1] - x0, dy = net.py[k + 1] - y0, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(wx - x0 - t * dx, wy - y0 - t * dy));
    }
    d = Math.max(0, d - net.ewS[e] / 2);
    if (d <= tol && d < bd) { bd = d; best = e; }
  }
  return best;
}
function drawNp(sc, cx, cy, hw, hh) {
  const P = (k) => [(net.px[k] - cx) * sc + hw, hh - (net.py[k] - cy) * sc];
  const edge = (e, side, col, lw, dash) => {          // side: +1 left kerb, -1 right kerb, 0 = the street itself
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash(dash); ctx.beginPath();
    const off = Math.max(1.5, net.ewS[e] * sc / 2) * side;
    for (let k = net.off[e]; k < net.off[e + 1] - 1; k++) {
      const [x0, y0] = P(k), [x1, y1] = P(k + 1), dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const ox = dy / l * off, oy = -dx / l * off;
      ctx.moveTo(x0 + ox, y0 + oy); ctx.lineTo(x1 + ox, y1 + oy);
    }
    ctx.stroke();
  };
  const wx0 = cx - hw / sc - 40, wx1 = cx + hw / sc + 40, wy0 = cy - hh / sc - 40, wy1 = cy + hh / sc + 40;
  const vis = (e) => !(net.bx1[e] < wx0 || net.bx0[e] > wx1 || net.by1[e] < wy0 || net.by0[e] > wy1);
  ctx.lineCap = 'butt';
  for (const e of NP.list) {
    if (!vis(e)) continue;
    if (NP.pk[e] & 1) edge(e, 1, '#ff5d5d', 2, [4, 3]);
    if (NP.pk[e] & 2) edge(e, -1, '#ff5d5d', 2, [4, 3]);
  }
  for (const e of npSelEdges()) {
    if (!vis(e)) continue;
    ctx.globalAlpha = 0.3; edge(e, 0, '#ffffff', Math.max(3, net.ewS[e] * sc + 4), []); ctx.globalAlpha = 1;
    edge(e, 1, '#ffa62b', 2.5, []); edge(e, -1, '#3fe0ff', 2.5, []);
  }
  ctx.setLineDash([]);
  for (const e of npSelEdges()) {                                   // arrows along a one-way street (direction of travel)
    if (!net.ow[e] || !vis(e)) continue;
    ctx.fillStyle = '#ffffff';
    let acc = 0;
    for (let k = net.off[e]; k < net.off[e + 1] - 1; k++) {
      const [x0, y0] = P(k), [x1, y1] = P(k + 1), l = Math.hypot(x1 - x0, y1 - y0); if (l < 1e-3) continue;
      const ux = (x1 - x0) / l, uy = (y1 - y0) / l, step = 46, sz = 6;
      for (let d = step - acc; d < l; d += step) {
        const X = x0 + ux * d, Y = y0 + uy * d;
        ctx.beginPath(); ctx.moveTo(X + ux * sz, Y + uy * sz); ctx.lineTo(X - ux * sz - uy * sz * 0.8, Y - uy * sz + ux * sz * 0.8); ctx.lineTo(X - ux * sz + uy * sz * 0.8, Y - uy * sz - ux * sz * 0.8); ctx.closePath(); ctx.fill();
      }
      acc = (acc + l) % step;
    }
  }
}
function npBind() {
  const dl = $('npNames'); net.names.forEach((n) => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  $('dirSel').addEventListener('change', (ev) => setDirection(parseInt(ev.target.value, 10)));
  $('dirReset').addEventListener('click', () => { applyStreets(net.ow0, new Uint8Array(net.E)); });
  $('npL').addEventListener('change', (ev) => npSetSide(1, ev.target.checked));
  $('npR').addEventListener('change', (ev) => npSetSide(2, ev.target.checked));
  $('npAll').addEventListener('change', (ev) => { NP.all = ev.target.checked; npUpdateSel(); needDraw = true; });
  $('npSelX').addEventListener('click', () => { NP.sel = null; npUpdateSel(); needDraw = true; });
  $('npReset').addEventListener('click', () => { NP.pk = npDefault(); npRefresh(true); });
  $('npClear').addEventListener('click', () => { NP.pk = new Uint8Array(net.E); npRefresh(true); });
  $('npSearch').addEventListener('change', (ev) => {
    const q = ev.target.value.trim().toLowerCase(); if (!q) return;
    const i = net.names.findIndex((n) => n.toLowerCase() === q); if (i < 0) return;
    let e0 = -1; for (let e = 0; e < net.E; e++) if (net.nm[e] === i) { e0 = e; break; }
    if (e0 < 0) return;
    NP.sel = e0; NP.all = true;
    const o = net.off[e0], q2 = (o + net.off[e0 + 1] - 1) >> 1; cam.x = net.px[q2]; cam.y = net.py[q2];
    npUpdateSel(); needDraw = true;
  });
  let down = null;                                           // click (not drag) on the map selects the nearest street
  cv.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, n: 1 }; });
  cv.addEventListener('pointerup', (ev) => {
    if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const r = cv.getBoundingClientRect(), e = npHit(ev.clientX - r.left, ev.clientY - r.top);
    NP.sel = e >= 0 ? e : null; NP.all = false; npUpdateSel(); needDraw = true;
  });
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
const MAJOR = ['moto', 'car', 'pickup', 'scooter', 'van', 'truck', 'lorry', 'jeep', 'bus', 'ebike'];   // sliders always visible; the rest sit in a drop-down
const typeRows = [];
// swatch = the type's colour at true proportions (3.2 px per metre, limited so every type stays visible)
function refreshLegend(i) {
  const row = typeRows[i], t = TYPES[i]; if (!row) return;
  const sw = row.querySelector('.sw');
  sw.style.width = Math.max(5, Math.min(30, t.L * 3.2)) + 'px';
  sw.style.height = Math.max(3, Math.min(9, t.W * 3.2)) + 'px';
  row.querySelector('small').textContent = t.L.toFixed(1) + ' × ' + t.W.toFixed(1) + ' m · ' + Math.round(t.v * 3.6) + ' km/h';
}
function buildTypeRows() {
  const box = $('types'), box2 = $('typesOther'); box.innerHTML = ''; box2.innerHTML = ''; typeRows.length = 0;
  let nOther = 0;
  TYPES.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'trow';
    row.innerHTML = `<span class="swc"><span class="sw" style="background:${t.color}"></span></span><label class="nm">${t.name}<small></small></label>
      <input type="number" min="0" step="1" class="cnum">
      <input type="range" class="crange" min="0" max="${t.max}" step="${t.step || 1}">`;
    const num = row.querySelector('.cnum'), rng = row.querySelector('.crange');
    num.addEventListener('input', () => { setCount(i, num.value); rng.value = counts[i]; markCustom(); });
    num.addEventListener('change', () => { num.value = counts[i]; });
    rng.addEventListener('input', () => { setCount(i, rng.value); num.value = counts[i]; markCustom(); });
    row._num = num; row._rng = rng;
    typeRows[i] = row; refreshLegend(i);
    if (MAJOR.includes(t.id)) box.appendChild(row); else { box2.appendChild(row); nOther++; }
  });
  $('otherSum').textContent = 'Other vehicle types (' + nOther + ')';
}

function syncTypeInputs() {
  for (let i = 0; i < typeRows.length; i++) { typeRows[i]._num.value = counts[i]; typeRows[i]._rng.value = counts[i]; }
  let o = 0; TYPES.forEach((t, i) => { if (!MAJOR.includes(t.id)) o += counts[i]; });
  const el = $('otherSum'); if (el) el.textContent = el.textContent.replace(/\s·.*$/, '') + ' · ' + fmt(o) + ' vehicles';
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
      refreshLegend(TYPES.indexOf(t)); pushDims();
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
  $('patRange').addEventListener('input', (ev) => { state.patience = +ev.target.value; $('patOut').textContent = state.patience ? state.patience + ' s' : 'off'; pushParams(); });
  $('safeChk').addEventListener('change', (ev) => { state.safe = ev.target.checked; $('safeBox').hidden = !state.safe; safeInfo(); pushParams(); });
  $('reactNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v >= 0 && v <= 4) { state.react = v; safeInfo(); pushParams(); } });
  $('muSel').addEventListener('change', (ev) => { state.mu = parseFloat(ev.target.value); safeInfo(); pushParams(); });
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

const safeGap = (v) => v * state.react + v * v / (2 * state.mu * 9.81);   // metres: reaction distance + braking distance
function safeInfo() {
  const row = (id) => { const t = TYPES.find((x) => x.id === id), g = safeGap(t.v); return `${t.name.toLowerCase()} ${Math.round(t.v * 3.6)} km/h → ${g.toFixed(1)} m (braking ${(t.v * t.v / (2 * state.mu * 9.81)).toFixed(1)} m)`; };
  $('safeInfo').innerHTML = 'Gap added in front of each moving vehicle at its free-flow speed: ' + ['moto', 'car', 'lorry'].map(row).join('; ') +
    '. Braking distance grows with the square of speed. Parked vehicles get no gap. With "Reduce vehicle speeds…" on, the gap shrinks as streets slow down.';
}
function updateStats() {
  const areaM2 = state.areaKm2 * 1e6;
  let foot = 0;
  for (let t = 0; t < nT; t++) foot += placed[t] * FP(t);     // only vehicles that fit are on the street
  const total = placedTotal(), req = requestedTotal();
  const useSafe = state.safe && stats.effFP != null;
  if (useSafe) foot = stats.effFP;                    // footprints + reaction/braking gap of moving vehicles
  const pct = foot / areaM2;
  const jam = state.jam;
  $('sArea').textContent = state.areaKm2.toFixed(3) + ' km²';
  $('sFoot').textContent = (foot / 1e6).toFixed(3) + ' km²  (' + fmt(foot) + ' m²)';
  $('sPct').textContent = (pct * 100).toFixed(1) + ' %';
  $('lFoot').textContent = useSafe ? 'Footprint + safe spacing (all)' : 'Vehicle footprint (all)';
  $('lPct').textContent = useSafe ? 'Coverage incl. safe spacing' : 'Coverage of road area';
  $('rowGap').hidden = !useSafe;
  if (useSafe) $('sGap').textContent = (stats.gapFP / areaM2 * 100).toFixed(1) + ' %  (' + fmt(stats.gapFP) + ' m²)';
  $('sParkFoot').textContent = (stats.parkedFP / areaM2 * 100).toFixed(1) + ' %';
  $('sVeh').textContent = fmt(total) + '  (' + fmt(stats.mv) + ' / ' + fmt(stats.parkedN) + ')';
  const unfit = req - total;
  $('sPlaced').textContent = unfit > 0 ? fmt(total) + ' of ' + fmt(req) + ' · ' + fmt(unfit) + ' do not fit' : fmt(total) + ' of ' + fmt(req);
  $('sPlaced').style.color = unfit > 0 ? '#f85149' : '';
  updateNoRoom(unfit, req, areaM2);
  $('sBlocked').textContent = stats.mv ? (stats.blockedN / stats.mv * 100).toFixed(0) + ' % waiting' : '–';
  $('sReloc').textContent = stats.relocN != null ? fmt(stats.relocN) : '–';
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
  $('barMarkLbl').textContent = 'packing limit ' + Math.round(jam * 100) + ' %' + (useSafe ? ' · incl. safe spacing' : '');
  if (yearsCfg) $('yearFleet').textContent = fmt(req) + ' vehicles';
  if (CLK.curves && !CLK.play) clkUI();
  updateCollisionPanel();
}

/* =====================================================================
 * 8b. "NO ROOM" BUBBLE
 * ===================================================================== */
function updateNoRoom(unfit, req, areaM2) {
  const box = $('noRoom');
  if (unfit <= 0 || !req) { box.hidden = true; return; }
  box.hidden = false;
  $('noRoomTxt').textContent = '⚠ ' + fmt(unfit) + ' vehicle' + (unfit === 1 ? '' : 's') + ' ha' + (unfit === 1 ? 's' : 've') + ' no room';
  if (!box.classList.contains('open')) return;                       // body is built only while it is open (cheap)
  let reqFoot = 0, plFoot = 0;
  for (let t = 0; t < nT; t++) { reqFoot += counts[t] * FP(t); plFoot += placed[t] * FP(t); }
  const miss = TYPES.map((t, i) => [t.name, counts[i] - placed[i]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const T = clkTotals(), parkWant = Math.round(T.pk), parkFit = stats.parkedN, mvFit = stats.mv;
  const noKerb = Math.max(0, parkWant - parkFit), noLane = Math.max(0, Math.round(T.mv) - mvFit);
  $('noRoomBody').innerHTML =
    `<b>Why they are not on the street</b><br>` +
    `Vehicles may never overlap and may not stand inside a junction. The ${fmt(req)} requested vehicles would cover ` +
    `<b>${(reqFoot / areaM2 * 100).toFixed(1)} %</b> of the ${state.areaKm2.toFixed(3)} km² street surface (footprints only). ${fmt(req - unfit)} fit (${(plFoot / areaM2 * 100).toFixed(1)} %).<br>` +
    `<span class="mut">Parked: ${fmt(parkFit)} of ${fmt(parkWant)} found kerb space${noKerb ? ' (' + fmt(noKerb) + ' did not)' : ''}. Moving: ${fmt(mvFit)} of ${fmt(Math.round(T.mv))} found lane space${noLane ? ' (' + fmt(noLane) + ' did not)' : ''}. ` +
    `Most affected: ${miss.map((x) => x[0] + ' ' + fmt(x[1])).join(', ')}.</span><br>` +
    `<span class="mut">Parking: the report counts 139,393 slots (132,230 motorcycle, 7,163 car), but OpenStreetMap maps only about 6 lots (about 1,100 spaces). The simulation therefore parks along street kerbs; a vehicle with no kerb space is treated as parked off-street. ` +
    `The count can fall as traffic moves, at quieter times of day, or with a wider kerb strip or more road area.</span>`;
}

/* =====================================================================
 * 8c. TRAFFIC ADVISOR (hotspots + what-if tests)
 * ===================================================================== */
const LEVELS = [
  { max: 0.15, name: 'Free-flowing', col: '#3fb950', txt: 'Most vehicles are moving.' },
  { max: 0.35, name: 'Busy', col: '#a3c02b', txt: 'Queues form at some junctions.' },
  { max: 0.55, name: 'Congested', col: '#e3a008', txt: 'A large share of vehicles is waiting.' },
  { max: 1.01, name: 'Severe', col: '#f85149', txt: 'Most vehicles are stopped; the network is close to gridlock.' },
];
const hotName = (h) => (net && h.nm >= 0 && net.names[h.nm]) || null;
const hotColor = (h) => (h.share > 0.75 ? '#f85149' : h.share > 0.5 ? '#e3a008' : '#a3c02b');

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hotInfo(h) {
  const tags = [], acts = [];
  const mvN = Math.max(1, h.mv);
  const goods = h.goods / mvN, park = h.n ? h.parked / h.n : 0;
  if (h.cov >= 1) tags.push('street at packing limit'); else if (h.cov >= 0.8) tags.push('street nearly full');
  if (h.w < 6.5) tags.push('narrow (' + h.w.toFixed(1) + ' m)');
  if (goods >= 0.06) tags.push('goods vehicles ' + Math.round(goods * 100) + ' %');
  if (park >= 0.15) tags.push('parked ' + Math.round(park * 100) + ' %');
  if (h.mix.length) { const t = TYPES[h.mix[0][0]], p = Math.round(100 * h.mix[0][1] / mvN); if (p >= 50) tags.push(t.name.toLowerCase() + 's ' + p + ' %'); }
  if (goods >= 0.06) acts.push('Limit goods vehicles (vans, pickups, lorries) to an off-peak delivery window.');
  if (park >= 0.15) acts.push('Clear kerbside parking here: enforcement, or move it to off-street parking.');
  if (h.w < 6.5 && !h.ow) acts.push('Trial one-way operation on this street.');
  if (h.cov >= 1) acts.push('Street is full: divert through-traffic to parallel streets, or meter entry at the upstream junction.');
  if (!acts.length) acts.push('Review priority and enforcement at both junctions; look for illegal stopping.');
  return { tags, acts: acts.slice(0, 3) };
}

function renderHot() {
  const lv = stats.mv ? stats.blockedN / stats.mv : 0;
  const L = LEVELS.find((x) => lv < x.max) || LEVELS[3];
  const chip = $('advChip'); chip.textContent = L.name; chip.style.background = L.col;
  $('advHead').textContent = stats.mv ? Math.round(lv * 100) + ' % of vehicles waiting. ' + L.txt : '';
  const box = $('hotList');
  if (!hot.length) { box.innerHTML = '<div class="note">No street segment has a significant queue right now.</div>'; return; }
  box.innerHTML = '';
  hot.slice(0, 5).forEach((h, k) => {
    const info = hotInfo(h), d = document.createElement('div');
    d.className = 'hot'; d.style.borderLeftColor = hotColor(h);
    const nm = hotName(h), geo = `${Math.round(h.len)} m, ${h.w.toFixed(1)} m wide, ${h.ow ? 'one-way' : 'two-way'}`;
    d.innerHTML = `<div class="h1"><span>${k + 1}. ${nm ? esc(nm) : geo + ' (unnamed)'}</span><span>${fmt(h.q)} waiting</span></div>` +
      `<div class="h2">${nm ? geo + ' · ' : ''}${Math.round(h.share * 100)} % of time stopped · ${fmt(h.n)} vehicles on this street</div>` +
      (info.tags.length ? `<div class="tags">${info.tags.map((x) => `<span class="tag">${x}</span>`).join('')}</div>` : '') +
      `<ul>${info.acts.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    d.addEventListener('click', () => { cam.x = h.x; cam.y = h.y; cam.scale = Math.max(cam.scale, 3.5); needDraw = true; });
    box.appendChild(d);
  });
}

/* ---- what-if tests: each scenario runs headless in its own worker ---- */
const ADV = { defs: [], res: {}, prog: {}, queue: [], workers: new Set(), busy: false, t0: 0, conc: 1 };
const GOODS_IDS = ['pickup', 'van', 'truck', 'lorry', 'mtruck', 'other'];
function scenarioDefs() {
  const c = Array.from(counts), f = (k) => c.map((n) => Math.round(n * k));
  const defs = [{ id: 'base', label: 'Now (no measure)', counts: c, P: {} }];
  defs.push({ id: 'rot', label: 'Plate rotation: 1 weekday in 5 off the road (−20 % vehicles)', counts: f(0.8), P: {} });
  defs.push({ id: 'goods', label: 'Goods vehicles off-peak only (−50 % pickups, vans, trucks, lorries)',
    counts: c.map((n, i) => Math.round(GOODS_IDS.includes(TYPES[i].id) ? n * 0.5 : n)), P: {} });
  const prop = c.map((n, i) => Math.round(n * (TYPES[i].count > 0 ? TYPES[i].proposed / TYPES[i].count : 1)));
  defs.push({ id: 'ium', label: 'IUM report proposal (Table 51), applied to this fleet', counts: prop, P: {} });
  const T = clkTotals(), pf = T.tot ? T.pk / T.tot : 0;
  if (pf > 0.01) defs.push({ id: 'park', label: 'Clear kerbside parking (parked vehicles move off-street)', counts: f(1 - pf), P: { parkShare: 0, parkShareT: null } });
  defs.push({ id: 'deep', label: 'Deep cut: −40 % vehicles (reference)', counts: f(0.6), P: {} });
  return defs;
}
const advUi = () => ({ run: $('advRun'), cancel: $('advCancel'), prog: $('advProg'), fill: $('advProgFill'), txt: $('advProgTxt'), res: $('advRes') });

function advStart() {
  if (ADV.busy) return;
  const u = advUi();
  if (typeof Worker === 'undefined' || !rawNetwork || requestedTotal() === 0) {
    u.txt.textContent = requestedTotal() === 0 ? 'Add vehicles first.' : 'Background workers are not available in this browser, so the tests cannot run.'; return;
  }
  ADV.defs = scenarioDefs(); ADV.res = {}; ADV.prog = {}; ADV.queue = ADV.defs.slice(); ADV.busy = true; ADV.t0 = now();
  ADV.conc = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  state.advBusy = true; pushParams();
  u.run.disabled = true; u.cancel.hidden = false; u.prog.hidden = false; u.fill.style.width = '0%'; u.res.innerHTML = '';
  advPump(); advProgress();
}
function advPump() {
  while (ADV.busy && ADV.workers.size < ADV.conc && ADV.queue.length) {
    const d = ADV.queue.shift(), w = new Worker('worker.js');
    ADV.workers.add(w); ADV.prog[d.id] = 0;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'scenarioProgress') { ADV.prog[m.id] = m.frac; advProgress(); }
      else if (m.type === 'scenarioResult') { ADV.res[m.id] = m.res; ADV.prog[m.id] = 1; w.terminate(); ADV.workers.delete(w); advProgress(); advPump(); advMaybeDone(); }
      else if (m.type === 'error') advFail(String(m.message).split('\n')[0]);
    };
    w.onerror = () => advFail('a test worker failed to start');
    const P = Object.assign(paramsMsg().P, d.P);
    w.postMessage({ cmd: 'scenario', id: d.id, raw: rawNetwork, dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })), p: { P }, counts: d.counts, warm: 25, meas: 15, noPark: Array.from(NP.pk), flow: { ow: Array.from(net.ow), fl: Array.from(net.fl) } });
  }
}
function advProgress() {
  const u = advUi(), n = ADV.defs.length;
  let f = 0; for (const d of ADV.defs) f += ADV.prog[d.id] || 0;
  const done = Object.keys(ADV.res).length;
  u.fill.style.width = (100 * f / n).toFixed(0) + '%';
  u.txt.textContent = 'Tested ' + done + ' of ' + n + ' · ' + Math.round((now() - ADV.t0) / 1000) + ' s elapsed';
}
function advStop() {
  for (const w of ADV.workers) w.terminate();
  ADV.workers.clear(); ADV.queue = []; ADV.busy = false; state.advBusy = false; pushParams();
  const u = advUi(); u.run.disabled = false; u.cancel.hidden = true; u.prog.hidden = true;
}
function advFail(msg) { advStop(); advUi().txt.textContent = 'Test stopped: ' + msg; }
function advMaybeDone() {
  if (Object.keys(ADV.res).length < ADV.defs.length) return;
  advStop(); advUi().txt.textContent = 'Finished in ' + Math.round((now() - ADV.t0) / 1000) + ' s.';
  advShowResults();
}
const NOISE_PP = 2;   // differences smaller than this (percentage points of free-flow speed) are treated as run-to-run noise
function advShowResults() {
  const b = ADV.res.base, rows = ADV.defs.map((d) => ({ d, r: ADV.res[d.id] }));
  const gain = (r) => r.speedPct - b.speedPct;
  const removed = (r) => b.placed - r.placed;
  const body = rows.slice(1).sort((x, y) => gain(y.r) - gain(x.r));
  const cell = (v, cls) => `<td class="${cls || ''}">${v}</td>`;
  const fmtPP = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0);
  let html = '<table class="res"><tr><th>Measure</th><th>Vehicles</th><th>Waiting</th><th>Speed</th><th>Gain</th></tr>';
  html += `<tr><td>${rows[0].d.label}</td>${cell(fmt(b.placed))}${cell(b.waitPct.toFixed(0) + ' %')}${cell(b.speedPct.toFixed(0) + ' %')}${cell('–')}</tr>`;
  for (const { d, r } of body) {
    const g = gain(r);
    html += `<tr><td>${d.label}</td>${cell(fmt(r.placed))}${cell(r.waitPct.toFixed(0) + ' %')}${cell(r.speedPct.toFixed(0) + ' %')}` +
      cell(Math.abs(g) < NOISE_PP ? 'no clear change' : fmtPP(g) + ' pts', Math.abs(g) < NOISE_PP ? 'flat' : g > 0 ? 'good' : '') + '</tr>';
  }
  html += '</table><div class="note" style="margin-top:0">Vehicles = on the street. Waiting = share of moving vehicles stopped. Speed = mean speed as % of free-flow; Gain = change in that % vs. now.</div>';
  const cand = body.filter((x) => x.d.id !== 'deep');
  const best = cand.length ? cand.reduce((p, q) => (gain(q.r) > gain(p.r) ? q : p)) : null;
  const eff = cand.filter((x) => removed(x.r) >= 200 && gain(x.r) >= NOISE_PP).sort((x, y) => gain(y.r) / removed(y.r) - gain(x.r) / removed(x.r))[0];
  let reco;
  if (!best || gain(best.r) < NOISE_PP) {
    reco = `None of the tested measures changes traffic flow clearly in this model (speed stays near ${b.speedPct.toFixed(0)} % of free-flow).` +
      (rows.find((x) => x.d.id === 'deep') ? ` Only the deep cut (−40 %) is shown for reference: ${fmtPP(gain(ADV.res.deep))} pts.` : '');
  } else {
    reco = `<b>Largest improvement:</b> ${best.d.label}. Mean speed ${b.speedPct.toFixed(0)} % → ${best.r.speedPct.toFixed(0)} % of free-flow, waiting ${b.waitPct.toFixed(0)} % → ${best.r.waitPct.toFixed(0)} %, with ${fmt(Math.max(0, removed(best.r)))} fewer vehicles on the street.`;
    if (eff && eff.d.id !== best.d.id) reco += `<br><b>Most effective per vehicle removed:</b> ${eff.d.label} (${(gain(eff.r) / removed(eff.r) * 1000).toFixed(1)} pts per 1,000 vehicles).`;
  }
  reco += `<br><span style="color:var(--mut)">Relative comparison inside an uncalibrated model, not a forecast. Gains under ${NOISE_PP} points are shown as “no clear change” (repeat runs differed by under 1 point in testing).</span>`;
  advUi().res.innerHTML = html + `<div class="reco">${reco}</div>`;
}
function bindAdvisor() {
  $('advRun').addEventListener('click', advStart);
  $('advCancel').addEventListener('click', () => { advStop(); advUi().txt.textContent = 'Cancelled.'; });
  $('hotChk').addEventListener('change', (ev) => { state.showHot = ev.target.checked; needDraw = true; });
  $('noRoomBtn').addEventListener('click', () => {
    const box = $('noRoom'); box.classList.toggle('open'); $('noRoomBtn').setAttribute('aria-expanded', box.classList.contains('open'));
    updateStats();
  });
}

/* =====================================================================
 * 9. MAIN LOOP (drawing only when something changed)
 * ===================================================================== */
let lastStatsT = 0;
function raf(t) {
  clkTick(t);
  if (hotDirty) { hotDirty = false; renderHot(); needDraw = true; }
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


function bindFull() {
  const p = $('panel'), btn = $('fullBtn');
  const set = (on) => {
    p.classList.toggle('full', on); btn.textContent = on ? '✕ Back to map' : '⤢ Full screen';
    if (on) p.scrollTop = 0;
    setTimeout(() => { clkDraw(); resize(); }, 300);
  };
  btn.addEventListener('click', () => set(!p.classList.contains('full')));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && p.classList.contains('full')) set(false); });
}

async function init() {
  buildTypeRows(); buildDims(); bindUI(); bindAdvisor(); bindFull(); safeInfo();
  resize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { resize(); }).observe(cv.parentElement);
  const [rawNet, years] = await Promise.all([loadJson('data/network.json'), loadJson('data/years.json')]);
  const raw = rawNet || GM.makeSyntheticNetwork();
  rawNetwork = raw;
  state.synthetic = !rawNet;
  if (state.synthetic) {
    const b = $('banner'); b.style.display = 'block';
    b.innerHTML = 'Showing a <b>placeholder network</b> because <code>data/network.json</code> was not found. ' +
      'Run <code>python tools/export_network.py</code> to build the real Greater Malé streets. ' +
      '(Opening index.html straight from disk also blocks loading — use <code>python -m http.server</code>.)';
  }
  net = GM.prepareNetwork(raw);
  GM.applyRoadArea(net, state.areaKm2);
  npLoadFlow(); NP.pk = npLoad(); npBind(); npRefresh(false);

  yearsCfg = years;
  if (yearsCfg) {
    fit = computeFit();
    const yr = $('yearRange');
    yr.min = yearsCfg.years[0]; yr.max = yearsCfg.years[yearsCfg.years.length - 1]; yr.step = 1;
    state.year = yearsCfg.years.includes(2026) ? 2026 : yearsCfg.baseline.year;   // default: the current year
    const sh = yearsCfg.accidents.greater_male_share; if (sh > 0) { state.share = sh; $('shareNum').value = Math.round(sh * 100); }
    state.beta = yearsCfg.model.beta_default || COL.beta; $('betaRange').value = state.beta;
  } else { $('yearRange').disabled = true; }
  if (yearsCfg && yearsCfg.usage && yearsCfg.usage.day_types) { clkBuild(yearsCfg.usage); clkBind(); clkSyncLive(); }
  else { CLK.on = false; $('clkOn').checked = false; $('clkOn').disabled = true; $('clkNote').textContent = 'data/years.json has no "usage" block: time of day is unavailable.'; }
  { const L = $('yearTicksLbl'); if (yearsCfg) yearsCfg.years.forEach((y) => { const s = document.createElement('span'); s.textContent = y; L.appendChild(s); }); }

  if (yearsCfg) { const yi = yearsCfg.years.indexOf(state.year); fleetForYearIdx(yi).forEach((n, i) => { counts[i] = n; }); }
  else TYPES.forEach((t, i) => { counts[i] = t.count; });
  syncTypeInputs();
  { const sr = $('scaleRange'); sr.value = Math.round(100 * requestedTotal() / TODAY_TOTAL); $('scaleOut').textContent = sr.value + ' %'; }
  fitView();
  updateYearUI(); clkUI();
  bootBackend({ cmd: 'init', raw, dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })), p: paramsMsg(), counts: Array.from(counts), noPark: Array.from(NP.pk), flow: { ow: Array.from(net.ow), fl: Array.from(net.fl) } });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(raf);
}

window.TrafficSim = { state, counts, placed, TYPES, setCount, applyCounts, mixCounts, applyYear, expectedPerYear,
  draw, updateStats, fitView, fleetForYearIdx,
  get net() { return net; }, get frame() { return frame; }, get stats() { return stats; }, get run() { return run; },
  get years() { return yearsCfg; }, get fit() { return fit; }, get sim() { return sim; }, get simRate() { return simRate; } };
init();
})();
