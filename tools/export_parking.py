#!/usr/bin/env python3
"""
export_parking.py - build data/parking.json (off-street parking lots) for the Greater Male' demo.

What it does
------------
1. Georeferences itself to data/network.json (the network stores metres relative to its
   south-west corner, so the corner's UTM position is needed). It uses meta.origin_utm when
   export_network.py wrote it, otherwise it downloads the OSM drive network again and matches
   its junctions to the ones in network.json (a one-off, takes a few seconds).
2. Downloads every OpenStreetMap parking feature in the bounding box (amenity=parking,
   amenity=motorcycle_parking, building=parking, parking=*). On-street parking
   (parking=street_side / lane / on_kerb ...) is skipped: the simulation already models kerbs.
3. Estimates the capacity of each lot:
      reported   OSM tag capacity / capacity:motorcycle                -> confidence "high"
      area       outline area / 28 m2 per car, / 3.8 m2 per motorcycle   -> confidence "medium"
                 (multi-storey lots: x number of levels; mixed lots: half the area each)
   These per-space areas include aisles and are modelling assumptions, not Maldivian standards.
   Change them with --m2-car / --m2-moto, and calibrate against lots whose capacity you know.
4. Merges your own lots (tools/parking_manual.csv and/or tools/parking_manual.geojson). A manual
   entry replaces an OSM lot with the same name, or one within --match-m metres, so you can
   correct capacities, set the vehicle class, mark lots temporary / planned / unverified, and add
   lots that OSM does not have.
5. Writes data/parking.json with every lot as a polygon in network metres.

Manual lots
-----------
  CSV  (tools/parking_manual.csv): one row per lot. Columns:
       name, status, use, moto_cap, car_cap, lat, lon, area_m2, confidence, source, notes
       Right-click the lot in Google Maps and click the coordinates to copy "lat, lon".
       Rows without coordinates are listed as "needs coordinates" and skipped.
  GeoJSON (tools/parking_manual.geojson): draw polygons over satellite imagery at geojson.io and
       give each feature the same properties (name, status, use, moto_cap, car_cap, ...).

  status : existing | temporary | planned | unverified
           (the dashboard counts existing + temporary by default; planned and unverified are switches)
  use    : car | moto | mixed   (mixed = the area is shared, half for each class)

Usage
-----
    pip install osmnx geopandas shapely pyproj numpy
    python tools/export_parking.py                   # OSM + manual files
    python tools/export_parking.py --no-osm          # manual files only (needs origin, see below)
    python tools/export_parking.py --origin 345678.9 467890.1   # UTM 43N of the network's SW corner

Output: data/parking.json
"""
import argparse
import csv
import datetime
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np

CRS_UTM = "EPSG:32643"
DEFAULT_BBOX = [73.465, 4.160, 73.560, 4.250]
M2_CAR = 28.0      # gross area per car space incl. aisles (25-30 typical)
M2_MOTO = 3.8      # gross area per motorcycle space incl. aisles (3-4.5 typical)
STATUSES = ("existing", "temporary", "planned", "unverified")
USES = ("car", "moto", "mixed")
ON_STREET = {"street_side", "lane", "on_kerb", "half_on_kerb", "shoulder", "parking_space", "layby"}


# ----------------------------------------------------------------------------------------------
# helpers (no network access needed)
# ----------------------------------------------------------------------------------------------
def to_int(v, default=0):
    try:
        return int(round(float(str(v).strip())))
    except (TypeError, ValueError):
        return default


def to_float(v, default=None):
    try:
        s = str(v).strip()
        return float(s) if s != "" else default
    except (TypeError, ValueError):
        return default


def norm_name(s):
    return "".join(ch for ch in str(s or "").lower() if ch.isalnum())


def classify_use(tags, name, default):
    n = (name or "").lower()
    if tags.get("amenity") == "motorcycle_parking" or tags.get("motorcycle") == "designated" \
            or any(k in n for k in ("motorcycle", "motorbike", "bike", "scooter")):
        return "moto"
    if tags.get("motorcar") == "designated" or any(k in n for k in ("car park", "carpark", "four wheel", "4 wheel")):
        return "car"
    return default


def estimate_caps(use, area_m2, levels=1.0, m2_car=M2_CAR, m2_moto=M2_MOTO):
    """Capacity (moto, car) from the outline area. mixed = half of the area for each class."""
    a = max(0.0, area_m2) * max(1.0, levels) * 0.92          # 8 % lost to ramps, stairs, structure
    if use == "car":
        return 0, int(a // m2_car)
    if use == "moto":
        return int(a // m2_moto), 0
    return int((a / 2) // m2_moto), int((a / 2) // m2_car)


def find_origin(local_nodes, utm_nodes, tol=1.0, min_frac=0.5):
    """Translation (UTM position of the network's local (0,0)) that best overlays two junction sets.
    local_nodes: Nx2 metres from network.json; utm_nodes: Mx2 UTM metres of a fresh OSM download.
    Votes over candidate offsets, then refines with the median residual of the matched junctions."""
    A = np.asarray(local_nodes, float)
    B = np.asarray(utm_nodes, float)
    rng = np.random.default_rng(1)
    pick = rng.choice(len(A), size=min(40, len(A)), replace=False)
    votes = Counter()
    for i in pick:
        keys = np.round((B - A[i]) / tol).astype(np.int64)
        votes.update(map(tuple, keys))
    (kx, ky), _ = votes.most_common(1)[0]
    off = np.array([kx, ky], float) * tol
    # refine and measure how many local junctions have an OSM junction within 3 m
    res = []
    for a in A:
        d = B - (a + off)
        j = int(np.argmin((d * d).sum(1)))
        if d[j] @ d[j] <= 9.0:
            res.append(d[j])
    frac = len(res) / len(A)
    if frac < min_frac:
        raise RuntimeError(f"could only match {frac:.0%} of the network junctions to OpenStreetMap; "
                           "OSM may have changed a lot since network.json was made - pass --origin X Y instead")
    off = off + np.median(np.asarray(res), axis=0)
    return float(off[0]), float(off[1]), frac


def square(cx, cy, area_m2):
    h = math.sqrt(max(area_m2, 4.0)) / 2
    return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]


def ring_area(ring):
    s = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def ring_centroid(ring):
    a = 0.0
    cx = cy = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-9:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    return cx / (3 * a), cy / (3 * a)


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def make_lot(name, status, use, moto, car, source, conf, ring=None, xy=None, area=None, note="",
             cap_source="reported", levels=None):
    if ring:
        area = ring_area(ring)
        cx, cy = ring_centroid(ring)
        schematic = False
    else:
        cx, cy = xy
        schematic = True
        ring = square(cx, cy, area or 150.0)
    return {
        "name": name or "Unnamed lot", "status": status, "use": use, "cap": {"moto": int(moto), "car": int(car)},
        "capSource": cap_source, "conf": conf, "src": source, "note": note,
        "area": int(round(area or 0)), "levels": levels, "schematic": schematic,
        "xy": [round(cx, 1), round(cy, 1)], "poly": [[round(x, 1), round(y, 1)] for x, y in ring],
    }


def lot_from_osm(tags, name, ring, xy, args):
    """tags: dict of OSM tags; ring: list of (x,y) local metres or None; xy: point for node lots."""
    use = classify_use(tags, name, args.default_use)
    cap_tag = to_int(tags.get("capacity"), 0)
    cap_moto_tag = to_int(tags.get("capacity:motorcycle"), 0)
    levels = to_float(tags.get("parking:levels") or tags.get("levels") or tags.get("building:levels"), None)
    ptype = tags.get("parking", "")
    if levels is None and ptype == "multi-storey":
        levels = 3.0
    note = []
    status = "existing"
    if tags.get("access") in ("private", "no"):
        note.append("private access")
    if tags.get("construction") or tags.get("highway") == "construction" or tags.get("proposed"):
        status = "planned"
    area = ring_area(ring) if ring else None
    if cap_moto_tag or cap_tag:
        moto = cap_moto_tag
        car = 0 if use == "moto" else cap_tag
        if use == "moto" and cap_tag and not cap_moto_tag:
            moto, car = cap_tag, 0
        return make_lot(name, status, use if not (moto and car) else "mixed", moto, car, "OpenStreetMap capacity tag",
                        "high", ring=ring, xy=xy, area=area, note="; ".join(note), cap_source="reported", levels=levels)
    if area:
        moto, car = estimate_caps(use, area, levels or 1.0, args.m2_car, args.m2_moto)
        if levels:
            note.append(f"{levels:g} levels assumed")
        return make_lot(name, status, use, moto, car, "OpenStreetMap outline, capacity estimated from area", "medium",
                        ring=ring, xy=xy, area=area, note="; ".join(note), cap_source="area", levels=levels)
    note.append("point only: add a capacity or an outline")
    return make_lot(name, status, use, 0, 0, "OpenStreetMap point (no outline, no capacity)", "low", xy=xy,
                    note="; ".join(note), cap_source="none")


def merge_manual(lots, man, match_m):
    """Apply one manual lot (dict from make_lot plus 'has_poly') onto the lot list."""
    key = norm_name(man["name"])
    hit = None
    for lt in lots:
        if key and norm_name(lt["name"]) == key:
            hit = lt
            break
    if hit is None:
        for lt in lots:
            if man["has_poly"] and point_in_ring(lt["xy"][0], lt["xy"][1], man["poly"]):
                hit = lt
                break
            if not man["has_poly"] and math.hypot(lt["xy"][0] - man["xy"][0], lt["xy"][1] - man["xy"][1]) <= match_m:
                hit = lt
                break
    use_given = man.get("use_given", True)
    m = {k: v for k, v in man.items() if k not in ("has_poly", "use_given")}
    if hit is None:
        lots.append(m)
        return "added"
    if not use_given:
        m.pop("use", None)
    if not (m["cap"]["moto"] or m["cap"]["car"]):      # a row that only changes status/name keeps the OSM capacity
        m.pop("cap", None)
        m.pop("capSource", None)
    keep_poly, keep_xy, keep_area, keep_sch = hit["poly"], hit["xy"], hit["area"], hit["schematic"]
    hit.update({k: v for k, v in m.items() if v not in (None, "")})
    if not man["has_poly"]:                    # a point row corrects the OSM lot but keeps its outline
        hit["poly"], hit["xy"], hit["schematic"] = keep_poly, keep_xy, keep_sch
        hit["area"] = hit["area"] if m.get("area") else keep_area
    return "updated"


def dedupe_points(lots):
    """A point lot that lies inside a polygon lot is the same lot: keep the polygon, borrow tagged capacity."""
    polys = [lt for lt in lots if not lt["schematic"]]
    out = []
    for lt in lots:
        if lt["schematic"] and lt["conf"] == "low":
            inside = next((p for p in polys if point_in_ring(lt["xy"][0], lt["xy"][1], p["poly"])), None)
            if inside is not None:
                continue
        out.append(lt)
    return out


def manual_from_row(r, to_local, args):
    name = (r.get("name") or "").strip()
    status = (r.get("status") or "existing").strip().lower()
    status = status if status in STATUSES else "unverified"
    use_raw = (r.get("use") or "").strip().lower()
    use = use_raw if use_raw in USES else "mixed"
    moto, car = to_int(r.get("moto_cap")), to_int(r.get("car_cap"))
    lat, lon = to_float(r.get("lat")), to_float(r.get("lon"))
    area = to_float(r.get("area_m2"))
    conf = (r.get("confidence") or "medium").strip().lower()
    src = (r.get("source") or "manual").strip()
    note = (r.get("notes") or "").strip()
    if lat is None or lon is None:
        return None, name
    x, y = to_local(lon, lat)
    cap_source = "manual"
    if not moto and not car and area:
        moto, car = estimate_caps(use, area, 1.0, args.m2_car, args.m2_moto)
        cap_source = "area"
    lot = make_lot(name, status, use, moto, car, src, conf, xy=(x, y), area=area, note=note, cap_source=cap_source)
    lot["has_poly"] = False
    lot["use_given"] = use_raw in USES
    return lot, name


def manual_from_feature(f, to_local, args):
    p = f.get("properties") or {}
    g = f.get("geometry") or {}
    status = str(p.get("status", "existing")).strip().lower()
    status = status if status in STATUSES else "unverified"
    use_raw = str(p.get("use", "")).strip().lower()
    use = use_raw if use_raw in USES else "mixed"
    moto, car = to_int(p.get("moto_cap")), to_int(p.get("car_cap"))
    conf = str(p.get("confidence", "medium")).strip().lower()
    src = str(p.get("source", "manual outline")).strip()
    note = str(p.get("notes", "")).strip()
    name = str(p.get("name", "")).strip()
    if g.get("type") == "Polygon":
        ring = [to_local(lon, lat) for lon, lat in g["coordinates"][0][:-1]]
        if len(ring) < 3:
            return None
        cap_source = "manual"
        if not moto and not car:
            moto, car = estimate_caps(use, ring_area(ring), to_float(p.get("levels"), 1.0) or 1.0, args.m2_car, args.m2_moto)
            cap_source = "area"
        lot = make_lot(name, status, use, moto, car, src, conf, ring=ring, note=note, cap_source=cap_source)
        lot["has_poly"] = True
        lot["use_given"] = use_raw in USES
        return lot
    if g.get("type") == "Point":
        lon, lat = g["coordinates"][:2]
        x, y = to_local(lon, lat)
        area = to_float(p.get("area_m2"))
        cap_source = "manual"
        if not moto and not car and area:
            moto, car = estimate_caps(use, area, 1.0, args.m2_car, args.m2_moto)
            cap_source = "area"
        lot = make_lot(name, status, use, moto, car, src, conf, xy=(x, y), area=area, note=note, cap_source=cap_source)
        lot["has_poly"] = False
        lot["use_given"] = use_raw in USES
        return lot
    return None


# ----------------------------------------------------------------------------------------------
# OpenStreetMap access (only used when not --no-osm)
# ----------------------------------------------------------------------------------------------
def osm_modules():
    try:
        import osmnx as ox
        from shapely.geometry import box
    except ImportError:
        sys.exit("Missing packages. Run:  pip install osmnx geopandas shapely pyproj numpy")
    return ox, box


def fetch_osm_nodes_utm(bbox):
    ox, box = osm_modules()
    west, south, east, north = bbox
    G = ox.graph_from_polygon(box(west, south, east, north), network_type="drive", simplify=True)
    G = ox.project_graph(G, to_crs=CRS_UTM)
    nodes = ox.graph_to_gdfs(G, nodes=True, edges=False)
    return np.column_stack([nodes["x"].to_numpy(), nodes["y"].to_numpy()])


def fetch_osm_parking(bbox):
    ox, box = osm_modules()
    west, south, east, north = bbox
    tags = {"amenity": ["parking", "motorcycle_parking"], "building": "parking", "parking": True}
    poly = box(west, south, east, north)
    try:
        gdf = ox.features_from_polygon(poly, tags)
    except AttributeError:                    # osmnx < 1.5
        gdf = ox.geometries_from_polygon(poly, tags)
    return gdf.to_crs(CRS_UTM)


# ----------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="data/network.json")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=None)
    ap.add_argument("--manual-csv", default="tools/parking_manual.csv")
    ap.add_argument("--manual-geojson", default="tools/parking_manual.geojson")
    ap.add_argument("--no-osm", action="store_true", help="skip OpenStreetMap, use the manual files only")
    ap.add_argument("--origin", nargs=2, type=float, metavar=("X", "Y"), help="UTM 43N position of the network's south-west corner")
    ap.add_argument("--default-use", choices=USES, default="mixed", help="class for OSM lots with no hint (default mixed)")
    ap.add_argument("--m2-car", type=float, default=M2_CAR)
    ap.add_argument("--m2-moto", type=float, default=M2_MOTO)
    ap.add_argument("--match-m", type=float, default=40.0, help="a manual point replaces an OSM lot within this distance")
    ap.add_argument("--min-area", type=float, default=60.0, help="ignore OSM outlines smaller than this (m2)")
    ap.add_argument("--out", default="data/parking.json")
    args = ap.parse_args()

    net = json.load(open(args.network))
    meta = net["meta"]
    bbox = args.bbox or meta.get("bbox_lonlat") or DEFAULT_BBOX
    bx, by = meta["bounds_m"]

    try:
        from pyproj import Transformer
    except ImportError:
        sys.exit("Missing package pyproj. Run:  pip install pyproj")
    tr = Transformer.from_crs("EPSG:4326", CRS_UTM, always_xy=True)

    # --- georeference -------------------------------------------------------------------------
    if args.origin:
        ox0, oy0 = args.origin
        how = "--origin"
    elif meta.get("origin_utm"):
        ox0, oy0 = meta["origin_utm"]
        how = "meta.origin_utm"
    else:
        print("network.json has no origin_utm: matching its junctions to OpenStreetMap ...")
        utm = fetch_osm_nodes_utm(bbox)
        ox0, oy0, frac = find_origin(net["nodes"], utm)
        how = f"matched {frac:.0%} of the junctions"
    print(f"origin (UTM 43N): {ox0:.1f}, {oy0:.1f}  [{how}]")

    def to_local(lon, lat):
        x, y = tr.transform(lon, lat)
        return x - ox0, y - oy0

    # --- OpenStreetMap lots -----------------------------------------------------------------
    lots, skipped = [], []
    if not args.no_osm:
        gdf = fetch_osm_parking(bbox)
        print(f"{len(gdf)} OpenStreetMap parking features")
        for idx, row in gdf.iterrows():
            tags = {k: v for k, v in row.items() if k != "geometry" and v == v and v is not None}
            if str(tags.get("parking", "")) in ON_STREET:
                skipped.append("on-street")
                continue
            geom = row.geometry
            name = tags.get("name:en") or tags.get("name") or ""
            gt = geom.geom_type
            if gt in ("Polygon", "MultiPolygon"):
                if gt == "MultiPolygon":
                    geom = max(geom.geoms, key=lambda g: g.area)
                if geom.area < args.min_area:
                    skipped.append("too small")
                    continue
                g2 = geom.simplify(0.5)
                ring = [(x - ox0, y - oy0) for x, y in list(g2.exterior.coords)[:-1]]
                if len(ring) > 80:
                    ring = [(x - ox0, y - oy0) for x, y in list(geom.simplify(1.5).exterior.coords)[:-1]]
                lots.append(lot_from_osm(tags, name, ring, None, args))
            elif gt == "Point":
                lots.append(lot_from_osm(tags, name, None, (geom.x - ox0, geom.y - oy0), args))
            else:
                skipped.append(gt)
        lots = dedupe_points(lots)
    else:
        print("OpenStreetMap skipped (--no-osm)")

    # --- manual lots ------------------------------------------------------------------------
    pending, merged = [], Counter()
    mp = Path(args.manual_csv)
    if mp.exists():
        with open(mp, newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                if not any((v or "").strip() for v in r.values() if isinstance(v, str)):
                    continue
                lot, nm = manual_from_row(r, to_local, args)
                if lot is None:
                    pending.append({"name": nm, "status": (r.get("status") or "").strip(),
                                    "moto_cap": to_int(r.get("moto_cap")), "car_cap": to_int(r.get("car_cap")),
                                    "source": (r.get("source") or "").strip(), "notes": (r.get("notes") or "").strip()})
                    continue
                merged[merge_manual(lots, lot, args.match_m)] += 1
    gp = Path(args.manual_geojson)
    if gp.exists():
        for f in json.load(open(gp)).get("features", []):
            lot = manual_from_feature(f, to_local, args)
            if lot is not None:
                merged[merge_manual(lots, lot, args.match_m)] += 1

    # --- keep lots on the network's map ----------------------------------------------------
    keep, outside = [], []
    for lt in lots:
        x, y = lt["xy"]
        (keep if -150 <= x <= bx + 150 and -150 <= y <= by + 150 else outside).append(lt)
    keep.sort(key=lambda lt: (-(lt["cap"]["car"] + lt["cap"]["moto"]), lt["name"]))
    for i, lt in enumerate(keep, 1):
        lt["id"] = f"L{i:03d}"

    out = {
        "meta": {
            "generated": datetime.date.today().isoformat(),
            "source": "OpenStreetMap contributors (ODbL) plus manual entries",
            "crs": CRS_UTM, "origin_utm": [round(ox0, 2), round(oy0, 2)], "origin_how": how,
            "assumptions": {"m2_per_car_space": args.m2_car, "m2_per_moto_space": args.m2_moto,
                            "note": "areas include aisles; modelling assumptions, not Maldivian standards"},
            "status_values": list(STATUSES), "use_values": list(USES),
            "n_lots": len(keep), "n_outside_map": len(outside),
            "outside_map": [lt["name"] for lt in outside],
            "needs_coordinates": pending,
        },
        "lots": keep,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(args.out, "w"), ensure_ascii=False, separators=(",", ":"))

    # --- summary --------------------------------------------------------------------------
    print(f"\nwrote {args.out}: {len(keep)} lots ({len(outside)} outside the network map)")
    if skipped:
        print("skipped OSM features:", dict(Counter(skipped)))
    if merged:
        print("manual entries:", dict(merged))
    by = {}
    for lt in keep:
        s = by.setdefault(lt["status"], [0, 0, 0])
        s[0] += 1
        s[1] += lt["cap"]["moto"]
        s[2] += lt["cap"]["car"]
    for st, (n, m, c) in sorted(by.items()):
        print(f"  {st:11s} {n:4d} lots   motorcycle spaces {m:7d}   car spaces {c:6d}")
    nocap = [lt["name"] for lt in keep if lt["cap"]["moto"] + lt["cap"]["car"] == 0]
    if nocap:
        print(f"  {len(nocap)} lots have no capacity yet (add capacity or an outline): " + ", ".join(nocap[:8]) + (" ..." if len(nocap) > 8 else ""))
    if pending:
        print(f"  {len(pending)} manual rows need coordinates (lat, lon) before they can be placed: " +
              ", ".join(p["name"] for p in pending[:8]) + (" ..." if len(pending) > 8 else ""))


if __name__ == "__main__":
    main()
