(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const TODAY_TOTAL = 119093;
const TYPES = [
  { id: 'moto', name: 'Motorcycles', color: '#ffa62b', max: 200000, step: 100 },
  { id: 'car', name: 'Cars', color: '#2ec4b6', max: 20000 },
  { id: 'pickup', name: 'Pickups', color: '#ff4d5e', max: 6000 },
  { id: 'scooter', name: 'Battery scooters', color: '#b57bff', max: 6000 },
  { id: 'van', name: 'Vans', color: '#34c3ff', max: 6000 },
  { id: 'truck', name: 'Trucks', color: '#ff7ac6', max: 4000 },
  { id: 'ebike', name: 'Electric bicycles', color: '#9be32f', max: 4000 },
  { id: 'lorry', name: 'Lorries (cargo)', color: '#ff8a8a', max: 3000 },
  { id: 'jeep', name: 'Jeeps', color: '#ffe14d', max: 2000 },
  { id: 'bus', name: 'Buses', color: '#8f7cff', max: 1000 },
  { id: 'other', name: 'Other / industrial', color: '#b8c2cc', max: 6000 },
];
const HEAT = ['#232c38', '#2b4a45', '#3f6b3a', '#7b7a25', '#a8691f', '#c2411f', '#d71f2e'];

const state = { areaKm2: 0.894, jam: 0.5, simSpeed: 10, dotPx: 2, paused: false, heat: true, slow: false };
const counts = new Int32Array(TYPES.length);
let netEdges = null, netBounds = [-500, -500, 500, 500], rawNetData = null;
let worker = null;
let latestSimData = null;

const cv = $('cv'), ctx = cv.getContext('2d');
const view = { w: 800, h: 600, dpr: window.devicePixelRatio || 1 };
const cam = { x: 0, y: 0, scale: 0.1 };

async function loadJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

function initWorker() {
  worker = new Worker('physics.worker.js');
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'READY') {
      applyCounts(TYPES.map((t, i) => Math.round(119093 * 0.6 * (i === 0 ? 0.86 : 0.06))));
    } else if (msg.type === 'TICK') {
      latestSimData = msg;
    }
  };
}

function startWorkerInit(raw) {
  rawNetData = raw;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  raw.edges.forEach(e => {
    for (let i = 0; i < e.p.length; i += 2) {
      minX = Math.min(minX, e.p[i]); minY = Math.min(minY, e.p[i+1]);
      maxX = Math.max(maxX, e.p[i]); maxY = Math.max(maxY, e.p[i+1]);
    }
  });
  netEdges = raw.edges;
  netBounds = [minX, minY, maxX, maxY];
  worker.postMessage({ type: 'INIT', rawNet: raw, bounds: netBounds });
}

function applyCounts(arr) {
  arr.forEach((v, i) => counts[i] = v);
  worker.postMessage({ type: 'SET_COUNTS', counts: Array.from(counts) });
}

function draw(sim) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, view.w, view.h);
  if (!netEdges || !sim) return;

  const sc = cam.scale, cx = cam.x, cy = cam.y, hw = view.w / 2, hh = view.h / 2;

  // Render Streets Batch
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  netEdges.forEach((e, idx) => {
    const bkt = state.heat ? sim.bkt[idx] : 0;
    ctx.strokeStyle = state.heat ? HEAT[bkt] : '#2f3b49';
    ctx.lineWidth = Math.max(0.7, (e.w || 5) * sc);
    ctx.beginPath();
    for (let i = 0; i < e.p.length; i += 2) {
      const X = (e.p[i] - cx) * sc + hw, Y = hh - (e.p[i+1] - cy) * sc;
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  });

  // Render Vehicles
  const { x, y, type, n } = sim.vehicles;
  ctx.fillStyle = '#ffa62b';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const X = (x[i] - cx) * sc + hw, Y = hh - (y[i] - cy) * sc;
    if (X > -6 && X < view.w + 6 && Y > -6 && Y < view.h + 6) {
      ctx.rect(X - 1, Y - 1, state.dotPx, state.dotPx);
    }
  }
  ctx.fill();
}

let lastT = 0;
function frame(t) {
  const real = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
  if (!state.paused && worker) {
    worker.postMessage({
      type: 'STEP',
      dt: Math.min(1.0, real * state.simSpeed),
      jam: state.jam, slow: state.slow, parkShare: 0
    });
  }
  if (latestSimData) draw(latestSimData);
  requestAnimationFrame(frame);
}

async function init() {
  initWorker();
  const raw = await loadJson('data/network.json') || makePlaceholderNet();
  startWorkerInit(raw);
  requestAnimationFrame(frame);
}

function makePlaceholderNet() {
  return { edges: [{ w: 10, p: [0,0, 1000,0, 1000,1000, 0,1000, 0,0] }] };
}

init();
})();
