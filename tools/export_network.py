#!/usr/bin/env python3
"""
export_network.py - build data/network.json for the Greater Male' traffic demo.

What it does
------------
1. Downloads the OpenStreetMap road network for Greater Male' (Male', Hulhumale',
   Villimale', the Sinamale bridge and the airport roads) with OSMnx.
   OSMnx turns the OSM one-way information (oneway=yes / -1, roundabouts, ...) into
   DIRECTED edges: a two-way street has one edge in each direction, a one-way street
   has a single edge that points in the direction of travel.
2. Keeps only the largest strongly connected part of that directed network, so a
   vehicle obeying the one-way rules can never be led into a street it cannot leave
   again (switch off with --keep-dead-ends).
3. Projects it to UTM 43N (metres) and merges the two directed edges of every two-way
   street into one record. A street that has only one directed edge is a one-way street.
4. Assigns a carriageway width to every edge (OSM `width` tag -> `lanes` tag ->
   default per highway class).
5. Calibrates ALL widths with one common factor so the union of the buffered
   streets equals --target-area (default 0.894 km2, your earlier OSMnx figure).
   The web app lets you slide the area between 0.80 and 1.00 km2 afterwards.
6. Writes a compact JSON (coordinates in metres, relative to the south-west
   corner) that the browser loads.

One-way encoding in network.json
--------------------------------
Every edge is {u, v, w, p} as before, and the polyline p always runs from node u to
node v. One-way streets get one extra key:

    "ow": 1     traffic may only travel from u to v (in the order of p)

Edges without "ow" are two-way. Loaders that do not know "ow" ignore it, so an
older simulation still treats every street as two-way.

Usage
-----
    pip install osmnx geopandas shapely
    python tools/export_network.py                     # defaults (one-way aware)
    python tools/export_network.py --target-area 0.902 # match the report
    python tools/export_network.py --bbox 73.465 4.160 73.560 4.250
    python tools/export_network.py --network-type all  # include minor ways
    python tools/export_network.py --keep-dead-ends    # do not prune to the strongly connected network
    python tools/export_network.py --ignore-oneway     # old behaviour: every street two-way

Output: data/network.json
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

try:
    import networkx as nx
    import osmnx as ox
    from shapely.geometry import box
    from shapely.ops import unary_union
except ImportError:  # pragma: no cover
    sys.exit("Missing packages. Run:  pip install osmnx geopandas shapely")

CRS_UTM = "EPSG:32643"  # UTM zone 43N (72-78 deg E) - covers Male' at 73.5 deg E

# Two directed edges are the two directions of ONE street when they join the same two
# nodes in opposite directions and their middles lie this close together (metres).
# This keeps two parallel one-way carriageways with equal length from being merged.
MATE_TOL_M = 1.5

# Rough carriageway widths (metres) when OSM has no width/lanes tag.
# Table 44 of the report lists the 18 major Male' roads at about 6-14 m.
DEFAULT_WIDTH_M = {
    "motorway": 14.0, "trunk": 14.0, "primary": 12.0, "secondary": 10.0,
    "tertiary": 9.0, "unclassified": 7.0, "residential": 6.0,
    "living_street": 5.0, "service": 4.5, "motorway_link": 8.0,
    "trunk_link": 8.0, "primary_link": 8.0, "secondary_link": 7.0,
    "tertiary_link": 6.0, "default": 6.0,
}


def first(v):
    """OSMnx sometimes stores several values as a list - take the first."""
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    return v


def parse_number(v):
    v = first(v)
    if v is None:
        return None
    m = re.search(r"[-+]?\d*\.?\d+", str(v))
    return float(m.group()) if m else None


def width_for(row):
    """Return (width_m, source) for one edge."""
    w = parse_number(row.get("width"))
    if w and 2.0 <= w <= 40.0:
        return w, "tag"
    lanes = parse_number(row.get("lanes"))
    if lanes and lanes > 0:
        return lanes * 3.0 + 1.0, "lanes"
    hw = first(row.get("highway"))
    return DEFAULT_WIDTH_M.get(hw, DEFAULT_WIDTH_M["default"]), "default"


def union_area(lines, widths, scale):
    polys = [ln.buffer(w * scale / 2.0) for ln, w in zip(lines, widths)]
    return unary_union(polys).area


def keep_strongly_connected(G):
    """Keep the largest strongly connected component of the directed OSMnx graph.

    With one-way streets a weakly connected network can still contain streets that can be
    entered but never left (or left but never entered). Vehicles that obey the one-way rules
    would pile up there, so those streets are dropped.
    """
    n0, e0 = G.number_of_nodes(), G.number_of_edges()
    comp = max(nx.strongly_connected_components(G), key=len)
    H = G.subgraph(comp).copy()
    n1, e1 = H.number_of_nodes(), H.number_of_edges()
    print(f"strongly connected network kept: {n1}/{n0} nodes, {e1}/{e0} directed edges")
    if e0 and (e0 - e1) / e0 > 0.05:
        print(f"  WARNING: {e0 - e1} directed edges ({(e0 - e1) / e0:.1%}) were dropped. If that is more than "
              "you expect, check the OSM one-way tags there, or use --keep-dead-ends.")
    return H


def collapse_streets(gdf_edges, ignore_oneway=False):
    """Turn OSMnx's directed edges into one record per physical street.

    Returns (rows, oneway). rows[i] is an edge row and oneway[i] says whether it is a one-way
    street. For a one-way street rows[i]["u"] -> rows[i]["v"] is the direction of travel (OSMnx
    already orients each directed edge and its geometry that way, also for oneway=-1). For a
    two-way street the direction of the kept row does not matter.

    Edges are grouped by the same key as before (end nodes + rounded length). Inside a group an
    edge that has a partner running the opposite way along the same line is a two-way street; an
    edge without a partner is a one-way street.

    ignore_oneway=True reproduces the old behaviour: one record per key, always two-way.
    """
    groups = {}
    for _, r in gdf_edges.iterrows():
        key = (min(r["u"], r["v"]), max(r["u"], r["v"]), round(float(r["length"]), 1))
        groups.setdefault(key, []).append(r)

    rows, oneway = [], []
    for grp in groups.values():
        if ignore_oneway:
            rows.append(grp[0])
            oneway.append(False)
            continue
        mids = [r["geometry"].interpolate(0.5, normalized=True) for r in grp]
        used = [False] * len(grp)
        for i, r in enumerate(grp):
            if used[i]:
                continue
            used[i] = True
            mate = None
            for j in range(i + 1, len(grp)):
                s = grp[j]
                if (not used[j] and s["u"] == r["v"] and s["v"] == r["u"]
                        and mids[i].distance(mids[j]) <= MATE_TOL_M):
                    mate = j
                    break
            if mate is not None:
                used[mate] = True
            rows.append(r)
            oneway.append(mate is None)
    return rows, oneway


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"),
                    default=[73.465, 4.160, 73.560, 4.250],
                    help="lon/lat bounding box (default covers Male', Hulhumale', Villimale')")
    ap.add_argument("--network-type", default="drive", help="OSMnx network type (drive, all, ...)")
    ap.add_argument("--target-area", type=float, default=0.894,
                    help="calibrate the union of street polygons to this many km2 (default 0.894)")
    ap.add_argument("--no-calibrate", action="store_true", help="keep raw estimated widths")
    ap.add_argument("--simplify-tol", type=float, default=0.5, help="geometry simplification, metres")
    ap.add_argument("--ignore-oneway", action="store_true",
                    help="old behaviour: ignore OSM one-way data, every street is two-way")
    ap.add_argument("--keep-dead-ends", action="store_true",
                    help="do not prune to the largest strongly connected network "
                         "(streets that one-way rules make impossible to leave/enter stay in)")
    ap.add_argument("--out", default="data/network.json")
    args = ap.parse_args()

    west, south, east, north = args.bbox
    print(f"Downloading OSM '{args.network_type}' network for bbox {args.bbox} ...")
    G = ox.graph_from_polygon(box(west, south, east, north),
                              network_type=args.network_type, simplify=True)
    if not args.ignore_oneway and not args.keep_dead_ends:
        G = keep_strongly_connected(G)
    G = ox.project_graph(G, to_crs=CRS_UTM)
    gdf_nodes, gdf_edges = ox.graph_to_gdfs(G, nodes=True, edges=True)
    gdf_edges = gdf_edges.reset_index()  # columns u, v, key

    # --- one record per street; a street with a single directed edge is one-way ----
    rows, oneway = collapse_streets(gdf_edges, ignore_oneway=args.ignore_oneway)
    n_ow = sum(oneway)
    print(f"{len(gdf_edges)} directed edges -> {len(rows)} streets "
          f"({len(rows) - n_ow} two-way, {n_ow} one-way)")
    if n_ow == 0 and not args.ignore_oneway:
        print("  note: no one-way streets were found in the OSM data for this area "
              "(they may be untagged in OpenStreetMap).")

    # --- widths --------------------------------------------------------------
    lines, widths, srcs = [], [], {"tag": 0, "lanes": 0, "default": 0}
    for r in rows:
        w, src = width_for(r)
        srcs[src] += 1
        widths.append(w)
        lines.append(r["geometry"].simplify(args.simplify_tol) if args.simplify_tol > 0 else r["geometry"])
    print(f"width source: {srcs}")

    raw_area = union_area(lines, widths, 1.0)
    print(f"uncalibrated street area: {raw_area / 1e6:.4f} km2")

    scale = 1.0
    if not args.no_calibrate:
        target = args.target_area * 1e6
        scale = target / raw_area
        for i in range(6):  # area is nearly linear in width -> converges fast
            a = union_area(lines, widths, scale)
            err = (a - target) / target
            print(f"  calibration pass {i + 1}: scale {scale:.4f} -> {a / 1e6:.4f} km2 ({err:+.2%})")
            if abs(err) < 0.002:
                break
            scale *= target / a
    final_area = union_area(lines, widths, scale)
    print(f"final street area: {final_area / 1e6:.4f} km2  (width scale x{scale:.3f})")

    # --- export ---------------------------------------------------------------
    used = sorted({int(r["u"]) for r in rows} | {int(r["v"]) for r in rows})
    remap = {n: i for i, n in enumerate(used)}
    minx = min(gdf_nodes.loc[n, "x"] for n in used)
    miny = min(gdf_nodes.loc[n, "y"] for n in used)
    maxx = max(gdf_nodes.loc[n, "x"] for n in used)
    maxy = max(gdf_nodes.loc[n, "y"] for n in used)

    def rel(x, y):
        return round(float(x - minx), 1), round(float(y - miny), 1)

    nodes = [list(rel(gdf_nodes.loc[n, "x"], gdf_nodes.loc[n, "y"])) for n in used]
    edges, total_len, ow_len = [], 0.0, 0.0
    for r, ln, w, ow in zip(rows, lines, widths, oneway):
        coords = list(ln.coords)
        u, v = int(r["u"]), int(r["v"])
        ux, uy = gdf_nodes.loc[u, "x"], gdf_nodes.loc[u, "y"]
        # make sure the polyline runs from node u to node v (for a one-way street that is the
        # direction of travel, which is what "ow": 1 refers to)
        if (coords[0][0] - ux) ** 2 + (coords[0][1] - uy) ** 2 > (coords[-1][0] - ux) ** 2 + (coords[-1][1] - uy) ** 2:
            coords.reverse()
        flat = []
        for x, y in coords:
            flat.extend(rel(x, y))
        if len(flat) < 4:
            continue
        total_len += float(ln.length)
        edge = {"u": remap[u], "v": remap[v], "w": round(w * scale, 2), "p": flat}
        if ow:
            edge["ow"] = 1
            ow_len += float(ln.length)
        edges.append(edge)

    n_ow_out = sum(1 for e in edges if "ow" in e)
    out = {
        "meta": {
            "source": "OpenStreetMap contributors (ODbL) via OSMnx",
            "generated": datetime.date.today().isoformat(),
            "crs": CRS_UTM,
            "bbox_lonlat": args.bbox,
            "network_type": args.network_type,
            "area_m2": round(final_area, 1),
            "target_area_km2": None if args.no_calibrate else args.target_area,
            "width_scale": round(scale, 4),
            "total_length_m": round(total_len, 1),
            "bounds_m": [round(float(maxx - minx), 1), round(float(maxy - miny), 1)],
            "n_nodes": len(nodes),
            "n_edges": len(edges),
            "oneway_mode": "ignored" if args.ignore_oneway else "osm",
            "oneway_encoding": 'edge "ow": 1 = travel only from node u to node v (order of p); no "ow" = two-way',
            "dead_ends_pruned": not (args.ignore_oneway or args.keep_dead_ends),
            "n_oneway_edges": n_ow_out,
            "n_twoway_edges": len(edges) - n_ow_out,
            "oneway_length_m": round(ow_len, 1),
        },
        "nodes": nodes,
        "edges": edges,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    share = ow_len / total_len if total_len else 0.0
    print(f"wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB, "
          f"{len(edges)} streets, {total_len / 1000:.1f} km of centreline; "
          f"{n_ow_out} one-way = {ow_len / 1000:.1f} km, {share:.0%} of the length)")


if __name__ == "__main__":
    main()
