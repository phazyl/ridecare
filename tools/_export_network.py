#!/usr/bin/env python3
"""
export_network.py - build data/network.json for the Greater Male' traffic demo.

What it does
------------
1. Downloads the OpenStreetMap road network for Greater Male' (Male', Hulhumale',
   Villimale', the Sinamale bridge and the airport roads) with OSMnx.
2. Projects it to UTM 43N (metres) and de-duplicates two-way edges.
3. Assigns a carriageway width to every edge (OSM `width` tag -> `lanes` tag ->
   default per highway class).
4. Calibrates ALL widths with one common factor so the union of the buffered
   streets equals --target-area (default 0.894 km2, your earlier OSMnx figure).
   The web app lets you slide the area between 0.80 and 1.00 km2 afterwards.
5. Writes a compact JSON (coordinates in metres, relative to the south-west
   corner) that the browser loads.

Usage
-----
    pip install osmnx geopandas shapely
    python tools/export_network.py                     # defaults
    python tools/export_network.py --target-area 0.902 # match the report
    python tools/export_network.py --bbox 73.465 4.160 73.560 4.250
    python tools/export_network.py --network-type all  # include minor ways

Output: data/network.json
Note: one-way tags are ignored on purpose - vehicles in the demo travel both
directions on every street (driving on the left).
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

try:
    import osmnx as ox
    from shapely.geometry import box
    from shapely.ops import unary_union
except ImportError:  # pragma: no cover
    sys.exit("Missing packages. Run:  pip install osmnx geopandas shapely")

CRS_UTM = "EPSG:32643"  # UTM zone 43N (72-78 deg E) - covers Male' at 73.5 deg E

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
    ap.add_argument("--out", default="data/network.json")
    args = ap.parse_args()

    west, south, east, north = args.bbox
    print(f"Downloading OSM '{args.network_type}' network for bbox {args.bbox} ...")
    G = ox.graph_from_polygon(box(west, south, east, north),
                              network_type=args.network_type, simplify=True)
    G = ox.project_graph(G, to_crs=CRS_UTM)
    gdf_nodes, gdf_edges = ox.graph_to_gdfs(G, nodes=True, edges=True)
    gdf_edges = gdf_edges.reset_index()  # columns u, v, key

    # --- de-duplicate the two directions of each street --------------------
    seen, rows = set(), []
    for _, r in gdf_edges.iterrows():
        key = (min(r["u"], r["v"]), max(r["u"], r["v"]), round(float(r["length"]), 1))
        if key in seen:
            continue
        seen.add(key)
        rows.append(r)
    print(f"{len(gdf_edges)} directed edges -> {len(rows)} undirected streets")

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
    edges, total_len = [], 0.0
    for r, ln, w in zip(rows, lines, widths):
        coords = list(ln.coords)
        u, v = int(r["u"]), int(r["v"])
        ux, uy = gdf_nodes.loc[u, "x"], gdf_nodes.loc[u, "y"]
        # make sure the polyline runs from node u to node v
        if (coords[0][0] - ux) ** 2 + (coords[0][1] - uy) ** 2 > (coords[-1][0] - ux) ** 2 + (coords[-1][1] - uy) ** 2:
            coords.reverse()
        flat = []
        for x, y in coords:
            flat.extend(rel(x, y))
        if len(flat) < 4:
            continue
        total_len += float(ln.length)
        edges.append({"u": remap[u], "v": remap[v], "w": round(w * scale, 2), "p": flat})

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
        },
        "nodes": nodes,
        "edges": edges,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB, "
          f"{len(edges)} streets, {total_len / 1000:.1f} km of centreline)")


if __name__ == "__main__":
    main()
