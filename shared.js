/* shared.js - vehicle table and street-network helpers.
 * Loaded by index.html (page) and by worker.js (importScripts), so both sides see identical data.
 */
(() => {
'use strict';
const GM = (globalThis.GM = globalThis.GM || {});

GM.MAX_VEHICLES = 300000;

/* ---------------------------------------------------------------------------
 * Vehicle table.  L, W in metres, v = free-flow speed in m/s.
 * `count`    = 2024 baseline fleet (IUM report, Table 3, Ministry of Transport 2024), sums to 119,093.
 *              Every Table 3 category is its own type (18 types); 'other' = the report's "Others" line.
 * `proposed` = fleet under the report's proposal (Table 51, "Overall Proposition"), sums to 89,413.
 *              Battery pickup is not listed in Table 51, so it is 0 here. 'other' = Table 51 "Others"
 *              196 + industrial vehicles 1,305 = 1,501. Table 51 uses a 119,472 base with industrial
 *              vehicles listed separately, whereas Table 3 (119,093) has them inside "Others" 1,109,
 *              hence 'other' goes 1,109 -> 1,501.
 * Footprints/speeds of the small types are assumptions (the report gives none).
 * data/years.json: ids it does not list fall back to its 'other' group.
 * Keep the ids: data/years.json maps them through `type_group`.
 * ------------------------------------------------------------------------- */
GM.TYPES = [
  { id: 'moto',    name: 'Motorcycle', color: '#ff7a45', L: 2.0, W: 0.8, v: 7.5, count: 103300, proposed: 76518, max: 220000, step: 50 },
  { id: 'car',     name: 'Car',        color: '#3fb6ff', L: 4.4, W: 1.8, v: 6.5, count: 7505,   proposed: 5610,  max: 20000,  step: 10 },
  { id: 'pickup',  name: 'Pickup',     color: '#a371f7', L: 5.2, W: 1.9, v: 6.0, count: 2050,   proposed: 1533,  max: 6000 },
  { id: 'scooter', name: 'Scooter',    color: '#f2cc60', L: 1.8, W: 0.7, v: 5.0, count: 1473,   proposed: 1473,  max: 6000 },
  { id: 'van',     name: 'Van',        color: '#56d4dd', L: 4.8, W: 1.9, v: 6.0, count: 1374,   proposed: 1027,  max: 6000 },
  { id: 'truck',   name: 'Truck',      color: '#db6d28', L: 7.0, W: 2.3, v: 5.0, count: 748,    proposed: 559,   max: 4000 },
  { id: 'ebike',   name: 'E-bike',     color: '#7ee787', L: 1.7, W: 0.6, v: 4.5, count: 453,    proposed: 339,   max: 4000 },
  { id: 'lorry',   name: 'Lorry',      color: '#f778ba', L: 8.0, W: 2.4, v: 5.0, count: 435,    proposed: 325,   max: 3000 },
  { id: 'jeep',    name: 'Jeep',       color: '#e3b341', L: 4.4, W: 1.9, v: 6.0, count: 354,    proposed: 265,   max: 2000 },
  { id: 'bus',     name: 'Bus',        color: '#ff5d5d', L: 9.0, W: 2.5, v: 5.5, count: 151,    proposed: 151,   max: 1000 },
  { id: 'bcar',    name: 'Battery car',     color: '#9be9a8', L: 3.2, W: 1.5, v: 5.0, count: 43,  proposed: 32,  max: 500 },
  { id: 'amb',     name: 'Ambulance',       color: '#ffffff', L: 5.5, W: 2.0, v: 6.0, count: 39,  proposed: 39,  max: 200 },
  { id: 'btri',    name: 'Battery tricycle',color: '#c297ff', L: 2.5, W: 1.1, v: 4.0, count: 20,  proposed: 15,  max: 500 },
  { id: 'minivan', name: 'Minivan',         color: '#79c0ff', L: 4.5, W: 1.7, v: 6.0, count: 16,  proposed: 16,  max: 200 },
  { id: 'bpick',   name: 'Battery pickup',  color: '#d29922', L: 4.5, W: 1.7, v: 4.5, count: 13,  proposed: 0,   max: 200 },
  { id: 'mtruck',  name: 'Mini truck',      color: '#ffa657', L: 4.0, W: 1.6, v: 5.0, count: 9,   proposed: 9,   max: 200 },
  { id: 'escoot',  name: 'Electric scooter',color: '#ffdf5d', L: 1.5, W: 0.6, v: 4.5, count: 1,   proposed: 1,   max: 100 },
  { id: 'other',   name: 'Other / industrial', color: '#8b98a8', L: 6.0, W: 2.4, v: 4.5, count: 1109, proposed: 1501, max: 6000 },
];

/* ---------------------------------------------------------------------------
 * Street network.  Raw format (data/network.json):
 *   { meta: {area_m2}, nodes: [...], edges: [ {u, v, w, p:[x0,y0,x1,y1,...], ow?} ] }
 * x/y in metres (y up), w = street width in metres, p = flat polyline running from node u to node v.
 * ow (optional): 1 = one-way street, traffic may only travel from u to v; absent/0 = two-way.
 *                (-1 = one-way from v to u is also accepted and is flipped on load.)
 * prepareNetwork() turns it into typed arrays; applyRoadArea() scales the widths so that the
 * total street surface equals the chosen area (this is what the "road area" slider drives).
 * ------------------------------------------------------------------------- */
GM.prepareNetwork = function prepareNetwork(raw) {
  const src = [];
  for (const e of raw.edges) {
    if (!e || !e.p || e.p.length < 4) continue;                       // need at least two points
    if (e.ow === -1) {                                                // allowed v -> u: flip so that u -> v is the legal way
      const p = [];
      for (let j = e.p.length - 2; j >= 0; j -= 2) p.push(e.p[j], e.p[j + 1]);
      src.push({ u: e.v, v: e.u, w: e.w, p, ow: 1, n: e.n });
    } else src.push(e);
  }
  const E = src.length;
  let P = 0, maxNode = (raw.nodes ? raw.nodes.length : 0) - 1;
  for (const e of src) {
    P += e.p.length >> 1;
    maxNode = Math.max(maxNode, e.u || 0, e.v || 0);
  }
  const N = maxNode + 1;
  const net = {
    E, N,
    u: new Int32Array(E), v: new Int32Array(E), w0: new Float32Array(E), len: new Float32Array(E),
    ow: new Uint8Array(E),             // 1 = one-way, legal direction u -> v
    nm: new Int16Array(E).fill(-1),    // street-name index into net.names (-1 = unnamed), from export_network.py
    names: (raw.meta && Array.isArray(raw.meta.names)) ? raw.meta.names : [],
    off: new Int32Array(E + 1), px: new Float32Array(P), py: new Float32Array(P), cum: new Float32Array(P),
    cumArea: new Float64Array(E), ewS: new Float32Array(E), bkt: new Uint8Array(E),
    bx0: new Float32Array(E), bx1: new Float32Array(E), by0: new Float32Array(E), by1: new Float32Array(E),
    bounds: [Infinity, Infinity, -Infinity, -Infinity], A0: 0,
  };
  let k = 0, sumA = 0;
  const b = net.bounds;
  src.forEach((e, i) => {
    net.u[i] = e.u || 0; net.v[i] = e.v || 0; net.w0[i] = e.w > 0 ? e.w : 5; net.off[i] = k;
    net.ow[i] = e.ow === 1 ? 1 : 0;
    if (Number.isInteger(e.n) && e.n >= 0 && e.n < net.names.length) net.nm[i] = e.n;
    let c = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < e.p.length; j += 2) {
      const x = e.p[j], y = e.p[j + 1];
      if (j > 0) c += Math.hypot(x - net.px[k - 1], y - net.py[k - 1]);
      net.px[k] = x; net.py[k] = y; net.cum[k] = c; k++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    net.len[i] = Math.max(c, 0.01);
    net.bx0[i] = x0; net.bx1[i] = x1; net.by0[i] = y0; net.by1[i] = y1;
    if (x0 < b[0]) b[0] = x0; if (y0 < b[1]) b[1] = y0; if (x1 > b[2]) b[2] = x1; if (y1 > b[3]) b[3] = y1;
    sumA += net.len[i] * net.w0[i];
    net.cumArea[i] = sumA;
  });
  net.off[E] = k;
  net.A0 = sumA;

  // adjacency (edge ids per node) for choosing the next street at a junction.
  // It lists the streets a vehicle may ENTER at that node: a two-way street at both of its ends,
  // a one-way street only at its start (u), so nobody can be routed into a one-way street against its direction.
  const deg = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) { deg[net.u[i] + 1]++; if (!net.ow[i]) deg[net.v[i] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  net.adjOff = deg.slice();
  net.adjE = new Int32Array(deg[N]);
  const fill = deg.slice(0, N);
  for (let i = 0; i < E; i++) { net.adjE[fill[net.u[i]]++] = i; if (!net.ow[i]) net.adjE[fill[net.v[i]]++] = i; }

  GM.applyRoadArea(net, 0.894);
  return net;
};

GM.applyRoadArea = function applyRoadArea(net, areaKm2) {
  const s = net.A0 > 0 ? (areaKm2 * 1e6) / net.A0 : 1;
  net.areaScale = s;
  for (let e = 0; e < net.E; e++) net.ewS[e] = net.w0[e] * s;
};

/* Placeholder grid used when data/network.json is missing (~0.89 km2 of streets). */
GM.makeSyntheticNetwork = function makeSyntheticNetwork() {
  const NX = 40, NY = 28, S = 48;
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const nodes = [], edges = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) nodes.push([i * S, j * S]);
  const id = (i, j) => j * NX + i;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      if (i < NX - 1) edges.push({ u: id(i, j), v: id(i + 1, j), w: 7.5 + rnd() * 2, p: [i * S, j * S, (i + 1) * S, j * S] });
      if (j < NY - 1) edges.push({ u: id(i, j), v: id(i, j + 1), w: 7.5 + rnd() * 2, p: [i * S, j * S, i * S, (j + 1) * S] });
    }
  }
  return { meta: { area_m2: 894000, synthetic: true }, nodes, edges };
};
})();
