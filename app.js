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
  safe: false, react: 1.5, mu: 0.6, idm: true, lotFirst: true, bayCap: true, bayMoto: 132230, bayCar: 7163, offLots: 1111, offPriv: 0,
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
    P: { areaKm2: state.areaKm2, parkShare: state.parkShare, parkShareT: clkParkArr(), parkStrip: state.parkStrip, jam: state.jam, slow: state.slow, patience: state.patience, safe: state.safe, react: state.react, mu: state.mu, idm: state.idm, lotOrder: state.lotFirst ? 'lot' : 'kerb', bayCap: state.bayCap, bayMoto: state.bayMoto, bayCar: state.bayCar },
    C: { on: state.colOn, perDay: A / 365 * clkExposure(), secPerDay: clkSecPerDay() },
    simSpeed: state.simSpeed, paused: state.paused || state.advBusy, hidden: typeof document !== 'undefined' && !!document.hidden,
  };
}
const engLots = () => (calSync(), { lots: LOTS.eng.map((l) => ({ name: l.name, xy: l.xy, poly: l.poly, ang: l.ang, bays: l.bays })), on: LOTS.eng.map(lotIsOn) });
const pushLotsOn = () => { if (sim) sim.post({ cmd: 'lotsOn', on: LOTS.eng.map(lotIsOn) }); };
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

  drawLots(sc, cx, cy, hw, hh);

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
const NP = { names: ['Boduthakurufaanu Magu', 'Sinamalé Bridge'], pk: null, list: [], sel: null, all: false, key: 'gm_streets_v3', bridge: null };
const npName = (e) => (net.nm[e] >= 0 ? net.names[net.nm[e]] : null);
const hrand = (e) => { let x = Math.imul(e + 1, 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
function npBridge() {                                       // the bridge road: closed to parking by default
  const f = new Uint8Array(net.E), ids = NP.names.map((n) => net.names.indexOf(n)).filter((i) => i >= 0), ends = [];
  const endPts = (e) => { const o = net.off[e], q = net.off[e + 1] - 1; return [[net.px[o], net.py[o]], [net.px[q], net.py[q]]]; };
  for (let e = 0; e < net.E; e++) if (ids.includes(net.nm[e])) { f[e] = 1; if (net.len[e] > 1000) ends.push(...endPts(e)); }
  // the bridge's other carriageway: long segments whose two ends lie within 150 m of those bridge ends
  const near = (p) => ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 150);
  for (let e = 0; e < net.E; e++) if (!f[e] && net.len[e] > 1000 && endPts(e).every(near)) f[e] = 1;
  return f;
}
// mode: 'one' = one kerb per street (random side, same every time), 'both', 'left', 'right', 'none'. Bridge road stays closed when keepBridge.
function npParking(mode, keepBridge) {
  NP.bridge = NP.bridge && NP.bridge.length === net.E ? NP.bridge : npBridge();
  const pk = new Uint8Array(net.E);
  for (let e = 0; e < net.E; e++) {
    if (keepBridge && NP.bridge[e]) { pk[e] = 3; continue; }
    pk[e] = mode === 'one' ? (hrand(e) < 0.5 ? 1 : 2) : mode === 'left' ? 2 : mode === 'right' ? 1 : mode === 'none' ? 3 : 0;   // bit 1 = left closed, bit 2 = right closed
  }
  return pk;
}
const npDefault = () => npParking('one', true);
const npGen = () => rawNetwork && rawNetwork.meta && rawNetwork.meta.generated;
function npStored() {
  try { const o = JSON.parse(localStorage.getItem(NP.key) || 'null'); if (o && o.n === net.E && o.gen === npGen()) return o; } catch (err) { /* storage unavailable */ }
  return null;
}
function npLoadFlow() {                                    // street directions saved in this browser (applied before kerb rules)
  const o = npStored(); if (!o) return;
  const ow = net.ow.slice(), fl = net.fl.slice();
  for (const [e, a, f] of (o.f || [])) if (e >= 0 && e < net.E) { ow[e] = a ? 1 : 0; fl[e] = f ? 1 : 0; }
  GM.applyFlow(net, ow, fl);
  if (Array.isArray(o.c)) { const cl = new Uint8Array(net.E); for (const e of o.c) if (e >= 0 && e < net.E) cl[e] = 1; GM.setClosed(net, cl); }
}
function npLoad() {
  const o = npStored();
  if (o && Array.isArray(o.b)) { const pk = new Uint8Array(net.E); for (const [e, m] of o.b) if (e >= 0 && e < net.E) pk[e] = m & 3; return pk; }
  return npDefault();
}
function npSave() {
  try {
    const b = [], f = [], c = [];
    for (let e = 0; e < net.E; e++) { if (net.cl[e]) c.push(e); if (NP.pk[e]) b.push([e, NP.pk[e]]); if (net.ow[e] !== net.ow0[e] || net.fl[e]) f.push([e, net.ow[e], net.fl[e]]); }
    localStorage.setItem(NP.key, JSON.stringify({ gen: npGen(), n: net.E, b, f, c }));
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
  let ow = 0, tw = 0, edited = 0, trap = 0, closed = 0, closedLen = 0;
  const inc = new Uint8Array(net.N);
  for (let e = 0; e < net.E; e++) { if (net.cl[e]) { closed++; closedLen += net.len[e]; continue; } if (net.ow[e]) { ow++; inc[net.v[e]] = 1; } else { tw++; inc[net.u[e]] = 1; inc[net.v[e]] = 1; } if (net.ow[e] !== net.ow0[e] || net.fl[e]) edited++; }
  for (let e = 0; e < net.E; e++) if (net.ow[e] && !net.cl[e]) { const v = net.v[e]; if (net.adjOff[v + 1] === net.adjOff[v]) trap++; else if (!inc[net.u[e]]) trap++; }
  $('dirSummary').innerHTML = `${ow - 0} one-way and ${tw} two-way segments` + (edited ? ` · <b>${edited} changed by you</b>` : '') +
    (closed ? `<br><b>${closed} segment${closed === 1 ? '' : 's'} closed to traffic</b> (${(closedLen / 1000).toFixed(1)} km)` : '') +
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
function setClosedSel(on) {
  if (NP.sel == null) return;
  const cl = net.cl.slice(); for (const e of npSelEdges()) cl[e] = on ? 1 : 0;
  applyStreets(net.ow.slice(), net.fl.slice(), cl);
}
function applyStreets(ow, fl, cl) {
  for (let e = 0; e < net.E; e++) if ((fl[e] ? 1 : 0) !== net.fl[e]) { const m = NP.pk[e]; NP.pk[e] = ((m & 1) << 1) | ((m >> 1) & 1); }   // same physical kerb after a reversal
  GM.applyFlow(net, ow, fl);
  if (cl) GM.setClosed(net, cl);
  if (sim) sim.post({ cmd: 'streets', ow: Array.from(ow), fl: Array.from(fl), mask: Array.from(NP.pk), cl: cl ? Array.from(cl) : null });
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
  $('clChk').checked = !!net.cl[e];
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
// Off-street lots: outline coloured by how full it is, with a dot for each vehicle parked there.
function lotGrid(l) {                                               // fixed positions inside the outline, one per space (visual only)
  const n = l.cap.moto + l.cap.car, [x0, y0, x1, y1] = l.bb, pts = [];
  if (n > 0 && l.m2 > 0) {
    const st = Math.max(1.3, Math.sqrt(l.m2 / n));
    for (let y = y0 + st / 2; y < y1 && pts.length < n; y += st) for (let x = x0 + st / 2; x < x1 && pts.length < n; x += st) {
      let ins = false; const q = l.poly;
      for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > y) !== (q[j][1] > y) && x < (q[j][0] - q[i][0]) * (y - q[i][1]) / (q[j][1] - q[i][1] + 1e-12) + q[i][0]) ins = !ins;
      if (ins) pts.push(x, y);
    }
  }
  l.g = new Float32Array(pts); l.gm = Math.round(l.g.length / 2 * (l.cap.moto / Math.max(1, n)));
}
function drawLots(sc, cx, cy, hw, hh) {
  if (!LOTS.show || !LOTS.list.length) return;
  const P = LOTS.plan || { usedMoto: 0, capMoto: 0, usedCar: 0, capCar: 0 };
  const fm = P.capMoto ? P.usedMoto / P.capMoto : 0, fc = P.capCar ? P.usedCar / P.capCar : 0;
  const wx0 = cx - hw / sc - 20, wx1 = cx + hw / sc + 20, wy0 = cy - hh / sc - 20, wy1 = cy + hh / sc + 20;
  const S = (x, y) => [(x - cx) * sc + hw, hh - (y - cy) * sc];
  ctx.lineJoin = 'round'; ctx.lineWidth = 1.5; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  for (const l of LOTS.list) {
    if (l.bb[2] < wx0 || l.bb[0] > wx1 || l.bb[3] < wy0 || l.bb[1] > wy1) continue;
    const on = lotIsOn(l); if (l.status === 'calibrated' && !on) continue;
    const cap = l.cap.moto + l.cap.car + l.cap.large, U = lotUsed(l), bn = U ? U.nm + U.nc + U.nl : 0, f = !on || !cap ? 0 : U ? (bn ? (U.m + U.c + U.l) / bn : 0) : 0;
    const col = !on ? '#8b98a8' : !cap ? '#a371f7' : f >= 0.97 ? '#f85149' : f >= 0.6 ? '#e3a008' : '#3fb950';
    const sw = (l.bb[2] - l.bb[0]) * sc, sh = (l.bb[3] - l.bb[1]) * sc, [mx, my] = S(l.xy[0], l.xy[1]);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    if (Math.max(sw, sh) < 7) {                                    // too small to see at this zoom: a ring marks it
      ctx.globalAlpha = 0.9; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1.5;
      if (on && f > 0) { ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(mx, my, 5 * Math.sqrt(f), 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1; continue;
    }
    ctx.beginPath();
    l.poly.forEach(([x, y], i) => { const [X, Y] = S(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.globalAlpha = on ? 0.16 : 0.06; ctx.fill();
    ctx.globalAlpha = on ? 0.95 : 0.6; ctx.setLineDash(!on || l.schematic || l.status === 'calibrated' ? [5, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    if (!l.bays && on && f > 0 && Math.max(sw, sh) > 14) {                    // parked vehicles: one dot per space, filled in order
      if (!l.g) lotGrid(l);
      const nm = Math.round(l.gm * fm), tot = l.g.length / 2, nc = Math.round((tot - l.gm) * fc), d = Math.max(1.6, Math.min(5, 1.1 * sc));
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = TYPES[0].color; for (let i = 0; i < nm; i++) { const [X, Y] = S(l.g[2 * i], l.g[2 * i + 1]); ctx.fillRect(X - d / 2, Y - d / 2, d, d); }
      ctx.fillStyle = TYPES[1].color; for (let i = 0; i < nc; i++) { const k = l.gm + i, [X, Y] = S(l.g[2 * k], l.g[2 * k + 1]); ctx.fillRect(X - d / 2, Y - d / 2, d, d); }
    }
    if (sc > 1.4 && Math.max(sw, sh) > 40) {
      ctx.globalAlpha = 1; ctx.fillStyle = '#e6edf3'; ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 3;
      const txt = l.name + (on && cap ? ' · ' + Math.round(f * 100) + ' %' : ''); ctx.strokeText(txt, mx, my - Math.max(6, sh / 2) - 4); ctx.fillText(txt, mx, my - Math.max(6, sh / 2) - 4); ctx.lineWidth = 1.5;
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
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
  for (let e = 0; e < net.E; e++) {                                  // streets closed to traffic: dark street with a red cross-hatch line
    if (!net.cl[e] || !vis(e)) continue;
    edge(e, 0, '#0d1117', Math.max(2, net.ewS[e] * sc), []);
    edge(e, 0, '#ff3b30', Math.max(1.5, Math.min(4, net.ewS[e] * sc * 0.25)), [8, 6]);
  }
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
  $('clChk').addEventListener('change', (ev) => setClosedSel(ev.target.checked));
  $('bulkApply').addEventListener('click', () => {
    const keep = $('bulkBridge').checked, pm = $('bulkPark').value, dm = $('bulkDir').value;
    NP.bridge = npBridge();
    if (dm === 'orig') applyStreets(net.ow0, new Uint8Array(net.E));
    else if (dm === 'two') applyStreets(new Uint8Array(net.E), new Uint8Array(net.E));
    else if (dm === 'one') applyStreets(new Uint8Array(net.E).fill(1), new Uint8Array(net.E));
    if (pm !== 'keep') { NP.pk = npParking(pm, keep); }
    npRefresh(true);
    if (sim) sim.post({ cmd: 'noPark', mask: Array.from(NP.pk) });
  });
  $('dirSel').addEventListener('change', (ev) => setDirection(parseInt(ev.target.value, 10)));
  $('dirReset').addEventListener('click', () => { applyStreets(net.ow0, new Uint8Array(net.E), new Uint8Array(net.E)); });
  $('npL').addEventListener('change', (ev) => npSetSide(1, ev.target.checked));
  $('npR').addEventListener('change', (ev) => npSetSide(2, ev.target.checked));
  $('npAll').addEventListener('change', (ev) => { NP.all = ev.target.checked; npUpdateSel(); needDraw = true; });
  $('npSelX').addEventListener('click', () => { NP.sel = null; npUpdateSel(); needDraw = true; });
  $('npReset').addEventListener('click', () => { NP.bridge = npBridge(); NP.pk = npDefault(); npRefresh(true); });
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
  const bayUi = () => { state.bayCap = $('bayChk').checked; $('bayMotoNum').disabled = $('bayCarNum').disabled = !state.bayCap; };
  $('bayChk').addEventListener('change', () => { bayUi(); pushParams(); });
  $('bayMotoNum').addEventListener('change', (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 0) { state.bayMoto = v; pushParams(); } });
  $('bayCarNum').addEventListener('change', (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 0) { state.bayCar = v; pushParams(); } });
  $('offLotsNum').addEventListener('input', (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 0) { state.offLots = v; needDraw = true; } });
  $('offPrivNum').addEventListener('input', (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 0) { state.offPriv = v; needDraw = true; } });
  $('stripNum').addEventListener('input', (ev) => { const v = parseFloat(ev.target.value); if (v > 0) { state.parkStrip = v; pushParams(); } });
  $('patRange').addEventListener('input', (ev) => { state.patience = +ev.target.value; $('patOut').textContent = state.patience ? state.patience + ' s' : 'off'; pushParams(); });
  $('lotFirstChk').addEventListener('change', (ev) => { state.lotFirst = ev.target.checked; pushParams(); });
  $('idmChk').addEventListener('change', (ev) => { state.idm = ev.target.checked; pushParams(); });
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
function catCounts(req, total) {                                    // every requested vehicle is in one of five places
  const sm = (a) => (a || []).reduce((x, y) => x + y, 0), pt = sm(stats.pt), lt = sm(stats.lt), ct = sm(stats.ct), mt = sm(stats.mt);
  return { kerb: Math.max(0, pt - lt), lot: lt, mov: Math.max(0, mt - ct), cru: ct, unp: Math.max(0, req - total) };
}
const PI = { t: 0, kerbM: 0 };
const BAYM2 = [2, 12.5, 36];                                       // ground of one bay: motorcycle 1 x 2 m, car-size 2.5 x 5 m, bus/truck 3 x 12 m
function kerbOpenM() {                                              // open kerb length (both sides, minus closed kerbs), metres
  if (!NP.pk || !net) return PI.kerbM;
  if (!PI.t || performance.now() - PI.t > 1000) {
    let m = 0; for (let e = 0; e < net.E; e++) { const mk = NP.pk[e], cs = net.cl[e] ? 2 : (mk & 1) + ((mk >> 1) & 1); m += usableKerb(e) * (2 - cs); }
    PI.kerbM = m; PI.t = performance.now();
  }
  return PI.kerbM;
}
const kerbMotoEst = () => 0.70 * Math.max(0, kerbOpenM() - 5.0 * state.bayCar);   // measured in the sim: about 0.7 motorcycle per metre of open kerb left after the car-size bays
function calSync() {                                                // switch on as many assumed zones as needed to bring kerb + lots up to the report's totals
  const cal = LOTS.list.filter((l) => l.status === 'calibrated'); if (!cal.length || !NP.pk) return false;
  let mapM = 0, mapL = 0;
  for (const l of LOTS.list) if (l.status !== 'calibrated' && LOTS.inc[l.status]) { mapM += l.nb[0]; mapL += l.nb[2]; }
  let heavy = 0; TYPES.forEach((tp, t) => { if (tp.L > 4.9 && tp.L <= 12) heavy += counts[t] * state.parkShare; });
  let needM = LOTS.inc.calibrated ? Math.max(0, state.bayMoto - kerbMotoEst() - mapM) : 0, needL = LOTS.inc.calibrated ? Math.max(0, heavy - mapL) : 0;
  let on = 0, gm = 0, gl = 0; const flags = [];
  for (const l of cal) { const isL = l.nb[2] > 0 && l.nb[0] === 0; let use = false; if (isL ? gl < needL : gm < needM) { use = true; if (isL) gl += l.nb[2]; else gm += l.nb[0]; on++; } l.calOn = use; if (use) flags.push(l.id); }
  const key = flags.join(',');
  LOTS.calInfo = { n: cal.length, on, moto: Math.round(gm), large: Math.round(gl), needM: Math.round(needM) };
  if (key === LOTS.calKey) return false;
  LOTS.calKey = key; return true;
}
function parkInfo(areaM2) {                                         // supply side of the parking ratios
  kerbOpenM();
  const cls = [0, 1, 2].map(() => ({ bays: 0, used: 0 })); let lotGround = 0, lotN = 0, mapN = 0, mapGround = 0;
  const lb = stats.lotBays, lu = stats.lu;
  if (lb && lu) lb.forEach((r, k) => { const l = LOTS.eng[r[0]]; if (!l || !lotIsOn(l)) return; lotGround += l.m2; lotN++; if (l.status !== 'calibrated') { mapN++; mapGround += l.m2; } for (let c = 0; c < 3; c++) { cls[c].bays += r[1 + c] || 0; cls[c].used += lu[3 * k + c]; } });
  const demand = TYPES.reduce((a, _, t) => a + Math.round(counts[t] * (clkOn() ? 1 - clkMoveShare(t) : state.parkShare)), 0);
  const lotBays = cls[0].bays + cls[1].bays + cls[2].bays, lotUsed = cls[0].used + cls[1].used + cls[2].used;
  const kerbBays = Math.round(kerbMotoEst() + state.bayCar);
  return { kerbArea: PI.kerbM * state.parkStrip, bays: kerbBays, lotGround, lotN, mapN, mapGround, cls, lotBays, lotUsed, demand };
}
function updateStats() {
  const areaM2 = state.areaKm2 * 1e6;
  let foot = 0;
  for (let t = 0; t < nT; t++) foot += placed[t] * FP(t);     // only vehicles that fit are on the street
  const hasCat = stats.kerbFP != null;
  if (hasCat) foot = stats.kerbFP + stats.movFP + stats.cruFP;       // road area only: vehicles standing in lots are off the road
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
  const C = catCounts(req, total), K = parkInfo(areaM2);
  if (calSync()) { lotsSummary(); pushLotsOn(); }
  $('sParkFoot').textContent = hasCat ? (stats.kerbFP / areaM2 * 100).toFixed(1) + ' %' : '–';
  $('sMovFoot').textContent = hasCat ? (stats.movFP / areaM2 * 100).toFixed(1) + ' %' : '–';
  $('sCruFoot').textContent = hasCat ? (stats.cruFP / areaM2 * 100).toFixed(1) + ' %' : '–';
  $('sNKerb').textContent = fmt(C.kerb); $('sNLot').textContent = fmt(C.lot); $('sNMov').textContent = fmt(C.mov);
  $('sNCru').textContent = fmt(C.cru) + (req ? '  (' + (100 * C.cru / req).toFixed(1) + ' %)' : ''); $('sNCru').style.color = C.cru > 0 ? '#e3a008' : '';
  $('rowUnp').hidden = C.unp <= 0; $('sNUnp').textContent = fmt(C.unp); $('sNUnp').style.color = C.unp > 0 ? '#f85149' : '';
  $('sKerbOcc').textContent = K.kerbArea > 0 && hasCat ? (100 * stats.kerbFP / K.kerbArea).toFixed(0) + ' %  (' + fmt(stats.kerbFP) + ' of ' + fmt(K.kerbArea) + ' m²)' : '–';
  $('sBayUse').textContent = K.bays ? (100 * C.kerb / K.bays).toFixed(0) + ' %  (' + fmt(C.kerb) + ' of about ' + fmt(K.bays) + ')' : '–';
  const FPc = stats.lotFPc || [0, 0, 0], CN = ['sLotM', 'sLotC', 'sLotL'];
  $('sLotGround').textContent = K.lotN ? fmt(K.lotGround) + ' m²  (' + K.mapN + ' mapped, ' + fmt(K.mapGround) + ' m², + ' + (K.lotN - K.mapN) + ' assumed zones)' : '–';
  $('sLotOcc').textContent = K.lotGround > 0 && hasCat ? (100 * stats.lotFP / K.lotGround).toFixed(0) + ' % of lot ground' : '–';
  K.cls.forEach((c, i) => { const A = c.bays * BAYM2[i]; $(CN[i]).textContent = c.bays ? (100 * c.used / c.bays).toFixed(0) + ' %  ·  ' + fmt(c.used) + ' of ' + fmt(c.bays) + ' bays  ·  ' + fmt(FPc[i]) + ' of ' + fmt(A) + ' m²' : '–'; });
  $('sLotBays').textContent = K.lotBays ? (100 * K.lotUsed / K.lotBays).toFixed(0) + ' %  (' + fmt(K.lotUsed) + ' of ' + fmt(K.lotBays) + ')' : '–';
  $('sPress').textContent = K.bays + K.lotBays ? (K.demand / (K.bays + K.lotBays)).toFixed(2) + ' vehicles per space  (' + fmt(K.demand) + ' want to park, ' + fmt(K.bays + K.lotBays) + ' spaces)' : '–';
  $('sPress').style.color = K.demand > K.bays + K.lotBays ? '#f85149' : '';
  $('sPlaced').textContent = fmt(total) + ' of ' + fmt(req) + ' on the map' + (C.cru > 0 ? ' · ' + fmt(C.cru) + ' circulating without a space' : '') + (C.unp > 0 ? ' · ' + fmt(C.unp) + ' beyond road capacity' : '');
  $('sPlaced').style.color = C.unp > 0 ? '#f85149' : '';
  updateNoRoom(C, req);
  $('sBlocked').textContent = stats.mv ? (stats.blockedN / stats.mv * 100).toFixed(0) + ' % waiting' : '–';
  $('sReloc').textContent = stats.relocN != null ? fmt(stats.relocN) : '–';
  const kmh = stats.mv ? stats.sumV / stats.mv * 3.6 : 0;
  const rel = stats.sumF ? stats.sumV / stats.sumF * 100 : 100;
  $('sSpeed').textContent = stats.mv ? kmh.toFixed(1) + ' km/h  (' + rel.toFixed(0) + ' % of free-flow)' : '–';
  $('sRate').textContent = state.paused ? 'paused' : simRate.toFixed(1) + '× real time (selected ' + state.simSpeed + '×)';
  $('sCong').textContent = (stats.congArea / areaM2 * 100).toFixed(1) + ' %';
  const meanFP = total - C.lot > 0 ? foot / (total - C.lot) : 0;
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
/* Off-street parking. Two kinds of supply:
 *   lots   - outlines from data/parking.json (tools/export_parking.py), each with motorcycle and car-size capacity;
 *            only the statuses ticked in the panel count. A motorcycle lot takes only motorcycle-size vehicles, a car lot only car-size ones.
 *   flex   - plain numbers any vehicle can use: "other off-street spaces" and private/residential garages.
 * Parked vehicles that found no kerb space go to the lots first, then to the flexible spaces. The model has no home address for a
 * vehicle, so every lot of a class fills evenly (same % full). */
const LOTS = { list: [], show: true, inc: { existing: true, temporary: true, planned: false, unverified: false, calibrated: true }, calKey: '', calInfo: null, plan: null, key: 'gm_lots_v1', pending: 0, meta: null, eng: [] };
const isMotoT = (t) => TYPES[t].L <= 2.3;
const lotIsOn = (l) => (l.status === 'calibrated' ? !!LOTS.inc.calibrated && !!l.calOn : !!LOTS.inc[l.status]);
function lotCaps(all) {                                             // lots with drawn bays are filled by the engine; only their un-drawn extra capacity is left to the accounting
  let moto = 0, car = 0;
  for (const l of LOTS.list) if (lotIsOn(l)) {
    if (l.bays && !all) { moto += l.extra ? l.extra.moto | 0 : 0; car += l.extra ? l.extra.car | 0 : 0; } else { moto += l.cap.moto; car += l.cap.car; }
  }
  return { moto, car };
}
function lotUsed(l) {                                               // vehicles standing in this lot's bays right now (engine count), or null
  const lb = stats.lotBays, lu = stats.lu; if (!l.bays || !lb || !lu) return null;
  const k = lb.findIndex((r) => r[0] === l.ei); if (k < 0) return null;
  return { m: lu[3 * k], c: lu[3 * k + 1], l: lu[3 * k + 2], nm: lb[k][1], nc: lb[k][2], nl: lb[k][3] || 0 };
}
const offFlex = () => Math.max(0, state.offLots) + Math.max(0, state.offPriv);
const offSupply = () => { const c = lotCaps(true); return offFlex() + c.moto + c.car; };
function shortPByType() {                                           // parked vehicles that found no kerb space, by type
  const haveSplit = stats.pt && stats.pt.length === nT, out = new Array(nT).fill(0);
  for (let t = 0; t < nT; t++) {
    const ps = clkOn() ? 1 - clkMoveShare(t) : state.parkShare, tP = Math.round(counts[t] * ps);
    out[t] = Math.max(0, tP - (haveSplit ? stats.pt[t] : Math.round(placed[t] * (stats.parkedN / Math.max(1, placedTotal())))));
  }
  return out;
}
function offPlan() {
  const sp = shortPByType(), cap = lotCaps(), off = new Array(nT).fill(0);
  let moto = cap.moto, car = cap.car, flex = offFlex(), tot = 0;
  const order = TYPES.map((_, i) => i).sort((a, b) => (isMotoT(a) ? 1 : 0) - (isMotoT(b) ? 1 : 0));   // car-size vehicles first: they have fewer places to go
  for (const t of order) {
    let need = sp[t];
    const m = isMotoT(t), take = Math.min(need, m ? moto : car);
    if (m) moto -= take; else car -= take;
    need -= take;
    const f = Math.min(need, flex); flex -= f;
    off[t] = take + f; tot += take + f;
  }
  return { off, total: tot, capMoto: cap.moto, capCar: cap.car, usedMoto: cap.moto - moto, usedCar: cap.car - car, flexCap: offFlex(), flexUsed: offFlex() - flex, short: sp };
}
function shortParkedNow() { return shortPByType().reduce((a, b) => a + b, 0); }

function lotArea(l) { let a = 0; const q = l.poly; for (let i = 0; i < q.length; i++) { const j = (i + 1) % q.length; a += q[i][0] * q[j][1] - q[j][0] * q[i][1]; } return Math.abs(a) / 2; }
function lotsInit(pk) {
  LOTS.list = pk && Array.isArray(pk.lots) ? pk.lots.filter((l) => l && l.poly && l.poly.length >= 3 && l.cap) : [];
  LOTS.meta = pk && pk.meta || null; LOTS.pending = LOTS.meta && LOTS.meta.needs_coordinates ? LOTS.meta.needs_coordinates.length : 0;
  if (!LOTS.list.length) return;
  for (const l of LOTS.list) {
    l.cap = { moto: Math.max(0, l.cap.moto | 0), car: Math.max(0, l.cap.car | 0), large: Math.max(0, l.cap.large | 0) };
    const bb0 = l.bays || {}; l.nb = [(bb0.moto || []).length / 3, (bb0.car || []).length / 3, (bb0.large || []).length / 3]; l.calOn = false;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of l.poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    l.bb = [x0, y0, x1, y1]; l.m2 = lotArea(l);
  }
  LOTS.list.sort((a, b) => ((a.status === 'calibrated') - (b.status === 'calibrated')) || (b.cap.moto + b.cap.car) - (a.cap.moto + a.cap.car) || (a.id < b.id ? -1 : 1));
  LOTS.eng = LOTS.list.filter((l) => l.bays && typeof l.ang === 'number'); LOTS.eng.forEach((l, i) => { l.ei = i; });
  try { const v = JSON.parse(localStorage.getItem(LOTS.key) || 'null'); if (v && v.inc) Object.assign(LOTS.inc, v.inc); if (v && typeof v.show === 'boolean') LOTS.show = v.show; } catch (e) { /* storage unavailable */ }
  state.offLots = 0; $('offLotsNum').value = 0;                      // the lots replace the single "OSM lots" figure
  $('offLotsLbl').textContent = 'Other off-street spaces not in the lot list (any vehicle)';
  $('lotsBox').hidden = false;
  const ids = { existing: 'lotExist', temporary: 'lotTemp', planned: 'lotPlan', unverified: 'lotUnv', calibrated: 'lotCal' };
  for (const st of Object.keys(ids)) {
    const el = $(ids[st]); el.checked = !!LOTS.inc[st];
    el.addEventListener('change', () => { LOTS.inc[st] = el.checked; lotsSave(); calSync(); lotsSummary(); pushLotsOn(); needDraw = true; });
  }
  $('lotShow').checked = LOTS.show;
  $('lotShow').addEventListener('change', (ev) => { LOTS.show = ev.target.checked; lotsSave(); needDraw = true; });
  lotsSummary();
}
function lotsSave() { try { localStorage.setItem(LOTS.key, JSON.stringify({ inc: LOTS.inc, show: LOTS.show })); } catch (e) { /* ignore */ } }
function lotsSummary() {
  const by = {}; for (const l of LOTS.list) { const b = by[l.status] || (by[l.status] = { n: 0, m: 0, c: 0 }); b.n++; b.m += l.cap.moto; b.c += l.cap.car; }
  const ids = { existing: 'lotExistN', temporary: 'lotTempN', planned: 'lotPlanN', unverified: 'lotUnvN', calibrated: 'lotCalN' };
  for (const st of Object.keys(ids)) { const b = by[st] || { n: 0, m: 0, c: 0 }; $(ids[st]).textContent = b.n ? '· ' + b.n + ' lot' + (b.n > 1 ? 's' : '') + ': ' + fmt(b.m) + ' motorcycle + ' + fmt(b.c) + ' car spaces' : '· none'; }
  const c = lotCaps(true), nocap = LOTS.list.filter((l) => lotIsOn(l) && !(l.cap.moto + l.cap.car)).length, CI = LOTS.calInfo;
  $('lotsNote').innerHTML = 'Counted now: <b>' + fmt(c.moto) + '</b> motorcycle and <b>' + fmt(c.car) + '</b> car-size spaces in lots.' +
    (CI && LOTS.inc.calibrated ? ' <b>Calibration:</b> ' + CI.on + ' of ' + CI.n + ' assumed zones are on (' + fmt(CI.moto) + ' motorcycle and ' + fmt(CI.large) + ' bus/truck bays) so that kerb + lots reach the report’s ' + fmt(state.bayMoto) + ' motorcycle slots. Their places and sizes are visual estimates.' : '') +
    (nocap ? ' ' + nocap + ' ticked lot' + (nocap > 1 ? 's have' : ' has') + ' no capacity yet.' : '') +
    (LOTS.pending ? ' ' + LOTS.pending + ' listed lot' + (LOTS.pending > 1 ? 's await' : ' awaits') + ' coordinates in tools/parking_manual.csv.' : '') +
    ' Capacities from outline area are estimates (about 28 m² per car, 3.8 m² per motorcycle including aisles).';
  needDraw = true;
}
function updateNoRoom(C, req) {
  const box = $('noRoom');
  if ((C.cru <= 0 && C.unp <= 0) || !req) { box.hidden = true; return; }
  box.hidden = false;
  $('noRoomTxt').textContent = C.cru > 0 ? '⚠ ' + fmt(C.cru) + ' vehicle' + (C.cru === 1 ? ' is' : 's are') + ' circulating without a parking space' + (C.unp > 0 ? ' · ' + fmt(C.unp) + ' beyond road capacity' : '')
    : '⚠ ' + fmt(C.unp) + ' vehicle' + (C.unp === 1 ? '' : 's') + ' beyond road capacity';
}


/* =====================================================================
 * 8d. PLACEMENT REPORT (why vehicles are not on the street, by type and area, and what would help)
 * ===================================================================== */
const ZONES = ['Malé', 'Hulhumalé', 'Bridge, airport & links'];
const zoneAt = (x, y) => (x < 2250 && y < 1400 ? 0 : y >= 3200 ? 1 : 2);      // by position on this network (Villimalé is not in the network file)
const RP = { open: false, timer: 0, data: null };
let edgeZone = null;
function rpPrep() {
  if (edgeZone && edgeZone.length === net.E) return;
  edgeZone = new Uint8Array(net.E);
  for (let e = 0; e < net.E; e++) { const k = net.off[e] + ((net.off[e + 1] - net.off[e]) >> 1); edgeZone[e] = zoneAt(net.px[k], net.py[k]); }
}
const usableKerb = (e) => Math.max(0, net.len[e] - 2 * Math.min(4, net.len[e] * 0.45));   // kerb length that parked vehicles can use (junction boxes excluded)
function rpCompute() {
  rpPrep();
  const areaM2 = state.areaKm2 * 1e6;
  const psT = TYPES.map((_, t) => (clkOn() ? 1 - clkMoveShare(t) : state.parkShare));
  const tP = TYPES.map((_, t) => Math.round(counts[t] * psT[t])), tM = TYPES.map((_, t) => counts[t] - tP[t]);
  const haveSplit = stats.pt && stats.mt && stats.pt.length === nT;
  const pt = TYPES.map((_, t) => (haveSplit ? stats.pt[t] : Math.round(placed[t] * (stats.parkedN / Math.max(1, placedTotal()))))), mt = TYPES.map((_, t) => placed[t] - pt[t]);
  const rows = TYPES.map((tp, t) => {
    const req = counts[t], on = placed[t], short = Math.max(0, req - on), lot = stats.lt && stats.lt.length === nT ? stats.lt[t] : 0;
    const ct = stats.ct && stats.ct.length === nT ? stats.ct[t] : 0, kerb = Math.max(0, pt[t] - lot), mov = Math.max(0, mt[t] - ct);
    return { t, name: tp.name, color: tp.color, req, on: on - lot, lot, kerb, mov, cru: ct, short, shortP: Math.max(0, tP[t] - pt[t]), shortM: Math.max(0, tM[t] - mt[t]), tP: tP[t], tM: tM[t] };
  }).filter((x) => x.req > 0).sort((a, b) => b.short - a.short || b.req - a.req);
  const plan = LOTS.plan = offPlan();                                     // parked vehicles with no kerb space go to the lots, then to the flexible spaces
  rows.forEach((x) => { x.off = x.lot; x.nobay = x.cru; x.noP = x.cru + Math.max(0, x.shortP - x.cru); });
  const sum = (k) => rows.reduce((s, x) => s + x[k], 0);
  const tot = { req: sum('req'), on: sum('on'), short: sum('short'), shortP: sum('noP'), shortM: sum('shortM'), off: sum('off'), nobay: sum('nobay'), shortPAll: sum('shortP'), kerb: sum('kerb'), lot: sum('lot'), mov: sum('mov'), cru: sum('cru'), unp: sum('short') };
  const lt = (t) => (stats.lt && stats.lt.length === nT ? stats.lt[t] : 0), ctt = (t) => (stats.ct && stats.ct.length === nT ? stats.ct[t] : 0);
  const KI = parkInfo(0);
  const bays = [0, 1, 2].map((q) => {                                       // vehicle classes by length: motorcycle-size, car-size (up to 4.9 m), larger (pickups, trucks, lorries, buses)
    const o = { dem: 0, kerb: 0, lot: 0, cru: 0, lotBays: KI.cls[q].bays };
    rows.forEach((x) => { const L = TYPES[x.t].L; if ((L <= 2.3 ? 0 : L <= 4.9 ? 1 : 2) !== q) return; o.dem += x.tP; o.lot += lt(x.t); o.cru += ctt(x.t); o.kerb += haveSplit ? stats.pt[x.t] - lt(x.t) : 0; });
    return o;
  });
  bays[0].slots = state.bayMoto; bays[0].used = bays[0].kerb + bays[0].lot; bays[1].slots = state.bayCar; bays[1].used = bays[0 + 1].lot + bays[1].kerb + bays[2].kerb;   // the report's car slots are shared by every vehicle that is not motorcycle-size at the kerb
  bays[0].kerbCap = Math.round(kerbMotoEst()); bays[1].kerbCap = state.bayCar;
  let wl = 0, wn = 0; for (let t = 0; t < nT; t++) { wl += tP[t] * (TYPES[t].L + 0.1); wn += tP[t]; }
  let sl = 0, sn = 0; rows.forEach((x) => { sl += x.shortP * (TYPES[x.t].L + 0.1); sn += x.shortP; });
  const Lavg = sn ? sl / sn : (wn ? wl / wn : 2.1);                       // mean length of the parked vehicles that lack space (incl. gap): they are the ones new kerb would hold
  let pLen = 0; for (let t = 0; t < nT; t++) pLen += (haveSplit ? stats.pt[t] - (stats.lt ? stats.lt[t] : 0) : pt[t]) * (TYPES[t].L + 0.1);   // kerb length the parked vehicles use now
  // areas: street and kerb lengths from the network, vehicles from the live positions
  const Z = ZONES.map((name) => ({ name, seg: 0, streetKm: 0, openKm: 0, closedKm: 0, parked: 0, moving: 0, pLen: 0 }));
  const cats = {}, byStreet = {};
  let openAll = 0, closedAll = 0;
  const add = (map, key, km) => { map[key] = (map[key] || 0) + km; };
  for (let e = 0; e < net.E; e++) {
    const z = Z[edgeZone[e]], u = usableKerb(e), m = NP.pk ? NP.pk[e] : 0;
    const closedSides = net.cl[e] ? 2 : (m & 1) + ((m >> 1) & 1);
    z.seg++; z.streetKm += net.len[e] / 1000; z.openKm += u * (2 - closedSides) / 1000; z.closedKm += u * closedSides / 1000;
    openAll += u * (2 - closedSides); closedAll += u * closedSides;
    if (closedSides && u > 0) {
      const cat = net.cl[e] ? 'Streets closed to traffic' : NP.bridge && NP.bridge[e] ? 'Bridge & ring road (default rule)' : closedSides === 2 ? 'No-parking streets (set by you)' : 'One kerb closed (one-side rule)';
      add(cats, cat, u * closedSides / 1000);
      const nm = net.nm[e] >= 0 ? net.names[net.nm[e]] : 'Unnamed streets'; (byStreet[nm] = byStreet[nm] || { km: 0, zones: {} }).km += u * closedSides / 1000;
      byStreet[nm].zones[edgeZone[e]] = 1;
    }
  }
  if (frame) {
    const { xs, ys, gs, n } = frame;
    for (let g = 0; g < nT * 2; g++) for (let i = gs[g]; i < gs[g + 1] && i < n; i++) { const z = Z[zoneAt(xs[i], ys[i])]; if (g & 1) { z.parked++; z.pLen += TYPES[g >> 1].L + 0.1; } else z.moving++; }
  }
  Z.forEach((z) => { z.occ = z.openKm > 0 ? Math.min(1, z.pLen / (z.openKm * 1000)) : 0; });
  const eff = tot.shortP > 0 && openAll > 0 ? Math.min(1, pLen / openAll) : 1;   // how much of the open kerb the placement really fills
  const gain = (km) => Math.min(tot.shortP, Math.round(km * 1000 / Lavg * eff));
  const levers = Object.entries(cats).map(([k, km]) => ({ name: k, km, n: gain(km) })).sort((a, b) => b.n - a.n);
  const streets = Object.entries(byStreet).map(([k, v]) => ({ name: k, km: v.km, n: gain(v.km), area: Object.keys(v.zones).map((q) => ZONES[q].split(',')[0]).join(' / ') })).sort((a, b) => b.n - a.n).slice(0, 8);
  const ctx = (CLK.curves ? (clkOn() ? DAYN[CLK.day] + ' ' + clkFmtTime(CLK.min) + (CLK.live ? ' (live, Maldives time)' : '') : 'time of day off') : '') + ' · fleet year ' + state.year + (state.yearCustom ? ' (edited)' : '');
  return { bays, rows, tot, Z, levers, streets, closedAllKm: closedAll / 1000, openAllKm: openAll / 1000, eff, Lavg, ctx, plan, allGain: gain(closedAll / 1000), cover: stats.effFP != null ? 0 : 0, areaM2, safe: state.safe };
}
const rpPct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '–');
function rpRender() {
  const d = RP.data = rpCompute(), T = d.tot;
  $('rpCtx').textContent = d.ctx + ' · parking: ' + d.openAllKm.toFixed(1) + ' km of kerb open, ' + d.closedAllKm.toFixed(1) + ' km closed';
  $('rpKpi').innerHTML = [['Requested', fmt(T.req), ''], ['Parked at the kerb', fmt(T.kerb), rpPct(T.kerb, T.req)], ['Parked in lots', fmt(T.lot), rpPct(T.lot, T.req)],
    ['Moving (trips)', fmt(T.mov), rpPct(T.mov, T.req)], ['Circulating, no parking space', fmt(T.cru), rpPct(T.cru, T.req)], ['Beyond road capacity', fmt(T.unp), T.unp ? 'not drawn: the road is full' : '']]
    .map((k, i) => `<div class="kpi${(i === 4 && T.cru) || (i === 5 && T.unp) ? ' bad' : ''}"><b>${k[1]}</b><span>${k[0]}</span><small>${k[2]}</small></div>`).join('');
  const mx = Math.max(1, ...d.rows.map((x) => x.req));
  const CLN = ['Motorcycle-size (up to 2.3 m)', 'Car-size (2.3 to 4.9 m: cars, vans, jeeps)', 'Larger (over 4.9 m: pickups, trucks, lorries, buses)'];
  $('rpBays').innerHTML = '<tr><th>Vehicle class</th><th>Wants to park</th><th>Parked in lots</th><th>Parked at the kerb</th><th>Circulating, no space</th><th>Lot bays counted</th></tr>' +
    d.bays.map((y, q) => `<tr><td>${CLN[q]}</td><td>${fmt(y.dem)}</td><td>${fmt(y.lot)}</td><td>${fmt(y.kerb)}</td><td class="${y.cru ? 'bad' : ''}">${fmt(y.cru)}</td><td>${fmt(y.lotBays)}</td></tr>`).join('') +
    `<tr><th colspan="6" style="padding-top:12px">The report's slots (kerb and off street together)</th></tr><tr><th>Class</th><th>Report slots</th><th>Used now (kerb + lots)</th><th>Free</th><th colspan="2">Note</th></tr>` +
    [0, 1].map((q) => { const y = d.bays[q]; return `<tr><td>${q ? 'Car-size and larger at the kerb, car-size in lots' : 'Motorcycle-size'}</td><td>${fmt(y.slots)}</td><td>${fmt(y.used)}</td><td class="${y.used >= y.slots ? 'bad' : ''}">${fmt(Math.max(0, y.slots - y.used))}</td><td colspan="2">${q ? 'The report’s 7,163 car slots are a hard limit on car-size parking: more cars want to park than the report has slots for.' : 'Calibration zones fill the gap between the kerb and this total.'}</td></tr>`; }).join('');
  $('rpLots').innerHTML = rpLotsHtml(d);
  const TH = '<tr><th>Vehicle type</th><th>Requested</th><th>Parked at kerb</th><th>Parked in lots</th><th>Moving (trips)</th><th>Circulating, no space</th><th>Beyond road capacity</th><th class="bar">Share circulating</th></tr>';
  $('rpTypes').innerHTML = TH + d.rows.map((x) => `<tr><td><i class="sw2" style="background:${x.color}"></i>${esc(x.name)}</td><td>${fmt(x.req)}</td><td>${fmt(x.kerb)}</td><td>${fmt(x.lot)}</td><td>${fmt(x.mov)}</td><td class="${x.cru ? 'bad' : ''}">${fmt(x.cru)} <small>${rpPct(x.cru, x.req)}</small></td><td>${fmt(x.short)}</td>` +
      `<td class="bar"><div class="bb" style="width:${(100 * x.req / mx).toFixed(1)}%"><div class="ok" style="width:${x.req ? (100 * x.cru / x.req).toFixed(1) : 0}%;background:#e3a008"></div></div></td></tr>`).join('') +
    `<tr class="tot"><td>All types</td><td>${fmt(T.req)}</td><td>${fmt(T.kerb)}</td><td>${fmt(T.lot)}</td><td>${fmt(T.mov)}</td><td>${fmt(T.cru)} <small>${rpPct(T.cru, T.req)}</small></td><td>${fmt(T.unp)}</td><td></td></tr>`;
  $('rpZones').innerHTML = '<tr><th>Area</th><th>Street km</th><th>Kerb open (km)</th><th>Kerb closed (km)</th><th>Parked now</th><th>Moving now</th><th>Kerb in use</th></tr>' +
    d.Z.filter((z) => z.seg).map((z) => `<tr><td>${esc(z.name)}</td><td>${z.streetKm.toFixed(1)}</td><td>${z.openKm.toFixed(1)}</td><td>${z.closedKm.toFixed(1)}</td><td>${fmt(z.parked)}</td><td>${fmt(z.moving)}</td><td class="${z.occ > 0.9 ? 'bad' : ''}">${(z.occ * 100).toFixed(0)} %</td></tr>`).join('');
  const shortP = T.shortP;
  $('rpLevers').innerHTML = shortP > 0
    ? `<div class="note" style="margin:0 0 6px">${fmt(shortP)} vehicles that want to park have no space and circulate. Re-opening kerb that rules have closed would fit about this many more (estimate; a kerb space is taken as ${d.Lavg.toFixed(1)} m, and the model fills about ${(d.eff * 100).toFixed(0)} % of open kerb):</div>` +
      '<table><tr><th>Closed kerb</th><th>km</th><th>≈ more vehicles</th></tr>' + d.levers.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.km.toFixed(1)}</td><td><b>${fmt(x.n)}</b></td></tr>`).join('') +
      `<tr class="tot"><td>All closed kerb</td><td>${d.closedAllKm.toFixed(1)}</td><td><b>${fmt(d.allGain)}</b></td></tr></table>` +
      '<div class="h4">Largest single gains</div><table><tr><th>Street</th><th>Area</th><th>Closed kerb (km)</th><th>≈ more vehicles</th></tr>' + d.streets.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.area)}</td><td>${x.km.toFixed(1)}</td><td>${fmt(x.n)}</td></tr>`).join('') + '</table>' +
      '<div class="note">Gains cannot exceed the vehicles that currently lack space, and they overlap: they do not add up when several kerbs are re-opened at once. Moving vehicles without lane space are not helped by kerb space; they need fewer vehicles or more road.</div>'
    : '<div class="note" style="margin:0">Every parked vehicle has kerb space, so re-opening closed kerb would not add capacity now.</div>';
  const mvShort = T.unp > 0 ? ` ${fmt(T.unp)} vehicles do not fit on the road at all and are not drawn.` : '';
  $('rpWhy').innerHTML = `<b>How to read this.</b> Vehicles may never overlap and may not stand inside a junction. ${fmt(T.cru)} vehicles that want to park found no free kerb or lot space and circulate on the streets looking for one.${mvShort} ` +
    '<br><b>Parking supply.</b> The report counts 132,230 motorcycle and 7,163 car parking slots, counted by the IUM team as public parking slots in Malé and Hulhumalé. The report does not say how they split between kerb and off-street; here kerb (one side of a street by default) plus lots plus assumed calibration zones are brought up to these totals. The simulation therefore parks along kerbs, one vehicle deep, on the kerbs that rules leave open: motorcycles end-on (1 m of kerb each, as in HDC’s bay standard) and everything else lengthwise. Car-size bays are shared by cars, pickups, vans and all larger vehicles. With “Limit kerb parking to the report’s bays” on, kerb parking stops at the report’s numbers. ' +
    (LOTS.list.length ? 'Off-street lots come from data/parking.json: ' + LOTS.list.length + ' lots, of which the statuses ticked in the panel are counted. Lots mapped in OpenStreetMap have a capacity estimated from their outline area unless a capacity is tagged; entries you added by hand are marked as such. ' : 'No lot outlines are loaded, so off-street space is the numeric setting only (OpenStreetMap tags capacity on about 6 lots, around 1,100 spaces). ') + '<b>Private and residential garages cannot be estimated</b>: HDC declined to share the data, so they default to 0 and should be entered by the user once known. A vehicle with no space keeps circulating, so it takes up road area like any moving vehicle; in reality it would park illegally, double-park or stay off the road. ' +
    'The areas are assigned by position on the map. The simulation does not assign vehicles to areas, so the shortfall is shown for the whole network, and the area table shows how full each area’s kerb is. Villimalé is not in the network file.';
}
function rpLotsHtml(d) {
  if (!LOTS.list.length) return '<div class="note" style="margin:0">No lot outlines loaded. Run <code>python tools/export_parking.py</code> to build <code>data/parking.json</code> from OpenStreetMap and your own list.</div>';
  const bas = { reported: 'reported', area: 'from area', manual: 'entered', layout: 'from layout', none: '–' };
  const tot = { m: 0, c: 0, l: 0, um: 0, uc: 0, ul: 0 }, calT = { n: 0, m: 0, c: 0, l: 0, um: 0, uc: 0, ul: 0 };
  const cell = (n, u) => fmt(n) + (n ? ' <small>(' + fmt(u) + ')</small>' : '');
  const rows = LOTS.list.map((l, i) => {
    const on = lotIsOn(l), U = lotUsed(l), nb = l.nb || [0, 0, 0], u = !on || !U ? [0, 0, 0] : [U.m, U.c, U.l];
    if (on) { tot.m += nb[0]; tot.c += nb[1]; tot.l += nb[2]; tot.um += u[0]; tot.uc += u[1]; tot.ul += u[2]; }
    if (l.status === 'calibrated') { if (on) { calT.n++; calT.m += nb[0]; calT.c += nb[1]; calT.l += nb[2]; calT.um += u[0]; calT.uc += u[1]; calT.ul += u[2]; } return ''; }
    const cap = nb[0] + nb[1] + nb[2], f = cap ? (u[0] + u[1] + u[2]) / cap : 0;
    return `<tr${on ? '' : ' style="opacity:.5"'}><td><a href="#" class="lotgo" data-i="${i}">${esc(l.name)}</a></td><td>${esc(l.status)}${on ? '' : ' (not counted)'}</td><td>${cell(nb[0], u[0])}</td><td>${cell(nb[1], u[1])}</td><td>${cell(nb[2], u[2])}</td><td class="${f > 0.97 ? 'bad' : ''}">${on && U && cap ? (f * 100).toFixed(0) + ' %' : '–'}</td><td>${bas[l.capSource] || esc(l.capSource || '')}</td><td>${esc(l.src || '')}</td></tr>`;
  });
  const calRow = calT.n ? `<tr><td><b>Calibration zones</b> (${calT.n} assumed, places estimated)</td><td>calibrated</td><td>${cell(calT.m, calT.um)}</td><td>${cell(calT.c, calT.uc)}</td><td>${cell(calT.l, calT.ul)}</td><td>${(100 * (calT.um + calT.uc + calT.ul) / Math.max(1, calT.m + calT.c + calT.l)).toFixed(0)} %</td><td>assumption</td><td>brings kerb + lots up to the IUM report totals</td></tr>` : '';
  return '<table><tr><th>Lot (click to zoom)</th><th>Status</th><th>Motorcycle bays (used)</th><th>Car-size bays (used)</th><th>Bus/truck bays (used)</th><th>Full</th><th>Capacity basis</th><th>Source</th></tr>' + rows.join('') + calRow +
    `<tr class="tot"><td>All counted lots</td><td></td><td>${cell(tot.m, tot.um)}</td><td>${cell(tot.c, tot.uc)}</td><td>${cell(tot.l, tot.ul)}</td><td>${tot.m + tot.c + tot.l ? (100 * (tot.um + tot.uc + tot.ul) / (tot.m + tot.c + tot.l)).toFixed(0) + ' %' : '–'}</td><td></td><td></td></tr></table>` +
    '<div class="note">Parked vehicles take a lot bay first (the nearest lot with a free bay of their class), and the kerb only when no lot bay is free; the tickbox in the panel reverses that. Motorcycle-size vehicles use motorcycle bays, vehicles up to 4.9 m use car-size bays, and pickups, trucks, lorries and buses (up to 12 m) use bus/truck bays. <b>Calibration zones are an assumption:</b> the IUM report counts public slots on streets and off street, but only a few lots are mapped, so assumed zones stand in for the rest. They are switched on only as far as needed to bring kerb + lots up to the report totals, and the switch in the panel turns them off to show the mapped lots alone.</div>';
}
function rpOpen() { RP.open = true; $('rp').hidden = false; document.body.classList.add('rpopen'); rpRender(); clearInterval(RP.timer); RP.timer = setInterval(rpRender, 1000); }
function rpClose() { RP.open = false; $('rp').hidden = true; document.body.classList.remove('rpopen'); clearInterval(RP.timer); }
function rpCsv() {
  const d = RP.data || rpCompute(), q = (s) => '"' + String(s).replace(/"/g, '""') + '"', L = [];
  L.push(['Placement report', d.ctx].map(q).join(','), '');
  L.push('Vehicle type,Requested,Parked at kerb,Parked in lots,Moving (trips),Circulating without a space,Beyond road capacity');
  d.rows.forEach((x) => L.push([q(x.name), x.req, x.kerb, x.lot, x.mov, x.cru, x.short].join(',')));
  L.push(['All types', d.tot.req, d.tot.kerb, d.tot.lot, d.tot.mov, d.tot.cru, d.tot.unp].join(','), '');
  L.push('Area,Street km,Kerb open km,Kerb closed km,Parked now,Moving now,Kerb in use %');
  d.Z.filter((z) => z.seg).forEach((z) => L.push([q(z.name), z.streetKm.toFixed(2), z.openKm.toFixed(2), z.closedKm.toFixed(2), z.parked, z.moving, (z.occ * 100).toFixed(0)].join(',')));
  L.push('', 'Closed kerb category,km,Approx. more vehicles if re-opened');
  d.levers.forEach((x) => L.push([q(x.name), x.km.toFixed(2), x.n].join(',')));
  L.push('', 'Street,Area,Closed kerb km,Approx. more vehicles if re-opened');
  d.streets.forEach((x) => L.push([q(x.name), q(x.area), x.km.toFixed(2), x.n].join(',')));
  if (LOTS.list.length) { L.push('', 'Off-street lot,Status,Counted,Motorcycle bays,Car-size bays,Bus/truck bays,Capacity basis,Source');
    LOTS.list.forEach((l) => { const nb = l.nb || [0, 0, 0]; L.push([q(l.name), l.status, lotIsOn(l) ? 'yes' : 'no', nb[0], nb[1], nb[2], l.capSource || '', q(l.src || '')].join(',')); }); }
  const blob = new Blob([L.join('\n')], { type: 'text/csv' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'placement-report.csv'; document.body.appendChild(a); a.click(); a.remove();
}
function rpBind() {
  $('rpClose').addEventListener('click', rpClose);
  $('rpLots').addEventListener('click', (ev) => { const a = ev.target.closest('.lotgo'); if (!a) return; ev.preventDefault(); const l = LOTS.list[+a.dataset.i]; if (l) { cam.x = l.xy[0]; cam.y = l.xy[1]; cam.scale = Math.max(cam.scale, 6); needDraw = true; rpClose(); } });
  $('rp').addEventListener('click', (ev) => { if (ev.target === $('rp')) rpClose(); });
  $('rpCsv').addEventListener('click', rpCsv);
  $('rpPrint').addEventListener('click', () => window.print());
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && RP.open) rpClose(); });
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
    w.postMessage({ cmd: 'scenario', lots: engLots(), id: d.id, raw: rawNetwork, dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })), p: { P }, counts: d.counts, warm: 25, meas: 15, noPark: Array.from(NP.pk), flow: { ow: Array.from(net.ow), fl: Array.from(net.fl), cl: Array.from(net.cl) } });
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
  $('noRoomBtn').addEventListener('click', rpOpen);
  $('rpOpen').addEventListener('click', rpOpen);
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
  const [rawNet, years, parking] = await Promise.all([loadJson('data/network.json'), loadJson('data/years.json'), loadJson('data/parking.json')]);
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
  lotsInit(parking);
  npLoadFlow(); NP.bridge = npBridge(); NP.pk = npLoad(); npBind(); rpBind(); npRefresh(false);

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
  bootBackend({ cmd: 'init', lots: engLots(), raw, dims: TYPES.map((t) => ({ L: t.L, W: t.W, v: t.v })), p: paramsMsg(), counts: Array.from(counts), noPark: Array.from(NP.pk), flow: { ow: Array.from(net.ow), fl: Array.from(net.fl), cl: Array.from(net.cl) } });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(raf);
}

window.TrafficSim = { state, counts, placed, TYPES, setCount, applyCounts, mixCounts, applyYear, expectedPerYear,
  draw, updateStats, fitView, fleetForYearIdx,
  get net() { return net; }, get frame() { return frame; }, get stats() { return stats; }, get run() { return run; },
  get years() { return yearsCfg; }, get fit() { return fit; }, get sim() { return sim; }, get simRate() { return simRate; } };
init();
})();
