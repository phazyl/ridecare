# Greater Malé Road Capacity Simulator

An interactive 2D traffic and parking simulation of Malé, Hulhumalé and the roads that join them. It illustrates the findings of the IUM report *"Assessment to Determine Vehicle Restrictions in the Greater Male' Region"* (March 2025, [read the report (PDF)](https://cdn.malecity.gov.mv/website/documents/I_pJsD4io5MuGL9_FUf-_-1.pdf)) and lets traffic officers test ideas on a live map before any road work or procurement.

It runs entirely in the browser. There is no server, no install and no build step, so it hosts for free on GitHub Pages.

> **Status: prototype.** The model is not calibrated against measured traffic counts or speeds. Use it to compare scenarios and explain space pressure, not to forecast exact figures.

## What it does

- **Fleet by year.** 2021 to 2026 vehicle counts by type (128,779 vehicles in 2026), each marked as reported, trend-based or estimated.
- **Time of day.** Pick a year, day and time. It follows the current Maldives time by default. About 11% of the fleet is on the move in the peak hour (per the report); the rest is parked at the kerb.
- **Real street network.** OpenStreetMap streets with names, widths, one-way rules and a road area calibrated to 0.894 km² (the report gives 0.902 km²).
- **Individual vehicles.** Every vehicle is a rectangle that never overlaps another. Motorcycles, cars, pickups, vans, lorries, buses and more.
- **IDM car-following.** Moving vehicles accelerate and brake smoothly using the Intelligent Driver Model, with starting parameters by size class and a random temperament for each driver. An optional safe-spacing setting adds reaction time and braking distance to the gap.
- **Parking model.** Kerbside parking one vehicle deep, motorcycles end-on, everything else lengthwise. The report's 132,230 motorcycle bays and 7,163 car-size bays are used as limits.
- **Off-street lots.** Parking lots are drawn as outlines on the map from `data/parking.json`, each with motorcycle and car-size capacity, a status (existing, temporary, planned, unverified) and a source. Vehicles that find no kerb space fill the lots of their class, shown as dots inside each outline. Garages and other spaces are numeric settings. See *Off-street parking lots* below.
- **Street editor.** Make a street one-way (either direction) or two-way, close it to all traffic, ban parking on one or both kerbs, or apply a rule to every street at once. Vehicles reroute on the fly. Settings are remembered in the visitor's own browser.
- **Placement report.** Which vehicle types do not fit, split by Malé, Hulhumalé and the bridge/airport/links, with estimates of how many more vehicles each re-opened kerb would fit. Exports to CSV and print.
- **Hotspots and measures.** Streets where queues form, plus side-by-side comparison of plate rotation, goods-vehicle time limits, the report's fleet cuts and clearing kerb parking.
- **Collision estimate.** A statistical estimate from Maldives Police Service accident counts (see below).
- **About page.** `about.html` explains the model in plain language for decision-makers.

## What kind of model is it?

A **stochastic, agent-based microsimulation**. Each vehicle is a separate agent moving in small time steps; randomness enters through starting positions, lane choice, junction turns, driver temperament and collision events. It is not a full Monte Carlo study: each scenario runs once, so small differences between measures should be read as noise. Running many seeds and reporting ranges is a planned improvement.

### Collision estimates

The simulation does not produce collisions from its physics, because vehicles never overlap. The figures are a separate statistical estimate:

```
accidents(year) = accidents(2024) × (fleet(year) ÷ fleet(2024)) ^ β
```

- Starts from police-reported accident counts, assuming 80% are in Greater Malé (an assumption).
- β defaults to 1.5, with 1.0 and 2.0 shown as a band.
- The red flashes on the map are random draws at that rate.

## Run it locally

```bash
git clone <your-repo-url>
cd <repo>
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works. Opening `index.html` directly from disk will not work in most browsers because the simulation runs in a web worker and loads JSON data.

## Deploy on GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages**, choose the branch (for example `main`) and the root folder.
3. The site appears at `https://<user>.github.io/<repo>/`.

## Project layout

| Path | Purpose |
|---|---|
| `index.html` | The dashboard page and all controls |
| `about.html` | Plain-language explanation and pitch, including accident estimates |
| `app.js` | User interface, clock, street editor, placement report, drawing |
| `core.js` | Simulation engine: vehicles, parking, IDM, junctions, coverage, hotspots, collisions |
| `shared.js` | Vehicle types and network preparation shared by page and workers |
| `worker.js` | Web worker that runs the engine off the main thread |
| `data/network.json` | Street network exported from OpenStreetMap |
| `data/years.json` | Fleet by year, time-of-day usage curves, accident series, model constants |
| `data/parking.json` | Off-street lots as outlines in network metres (built by `tools/export_parking.py`; optional) |
| `tools/export_network.py` | Rebuilds `data/network.json` with OSMnx |
| `tools/export_parking.py` | Builds `data/parking.json` from OpenStreetMap and your own list |
| `tools/parking_manual.csv` | Your own lots: name, status, class, capacity, coordinates, source |

## Rebuilding the street network

```bash
pip install osmnx geopandas shapely pyproj
python3 tools/export_network.py
```

This downloads the OpenStreetMap network, keeps the largest strongly connected part, projects it to metres, merges two-way streets, assigns widths (OSM `width`, then `lanes`, then class defaults) and calibrates them so the road area matches the target. It also extracts street names. See the header of the script for options. Villimalé is not in the current network file, so it does not appear on the map.

## Off-street parking lots

No official list of Malé or Hulhumalé off-street lots is published (the IUM report says neither the city council nor the transport ministry holds one, and HDC did not share its lists), so the lot layer is built from open data plus your own entries, and every lot carries its source and confidence.

```bash
pip install osmnx geopandas shapely pyproj numpy
python3 tools/export_parking.py
```

1. **OpenStreetMap lots.** Every `amenity=parking`, `amenity=motorcycle_parking`, `building=parking` and `parking=*` feature is pulled (on-street parking is skipped). A `capacity` tag is used when present; otherwise capacity is estimated from the outline area at about 28 m² per car space and 3.8 m² per motorcycle space including aisles (`--m2-car`, `--m2-moto`). These are assumptions, not Maldivian standards, and should be calibrated against lots whose capacity is known.
2. **Your own lots.** Edit `tools/parking_manual.csv` (right-click a lot in Google Maps to copy its `lat, lon`), and/or draw outlines at [geojson.io](https://geojson.io) over satellite imagery and save them as `tools/parking_manual.geojson` with properties `name`, `status`, `use`, `moto_cap`, `car_cap`, `source`. A manual entry replaces an OSM lot of the same name or within 40 m. Rows without coordinates are listed and skipped.
3. **Status.** `existing` and `temporary` lots count by default; `planned` buildings (a future scenario) and `unverified` leads are switches in the panel.
4. **Placement.** The model has no home address for a vehicle, so parked vehicles with no kerb space fill the lots of their class evenly: motorcycle-size vehicles use motorcycle capacity, car-size vehicles use car capacity, and any left over use the numeric garage and other-space settings. Lots in Villimalé are listed but not drawn, because it is not in the network file.

The Placement report lists every lot with its capacity, estimated fill, capacity basis and source, and the CSV export includes them.

## Data sources and assumptions

- [IUM report (March 2025)](https://cdn.malecity.gov.mv/website/documents/I_pJsD4io5MuGL9_FUf-_-1.pdf): 2024 fleet of 119,093 vehicles, peak-hour share (11.05%), parking slots surveyed along streets.
- National Bureau of Statistics vehicle registrations: yearly trend for 2021 to 2026.
- Maldives Police Service accident counts via MV+. The 2026 figure is annualised from 2,379 recorded up to mid-October.
- OpenStreetMap contributors (ODbL) for the street network.

Assumptions that are **not** measured data:

- Day curves between the report's peak windows, and Friday/Saturday patterns, are assumed. The report gives no weekend breakdown.
- Private and residential garages are unknown because HDC declined to share the data, so they start at zero as a user setting.
- Off-street lot capacities that are not tagged in OpenStreetMap are estimated from outline area, and lots are filled evenly by class rather than by location.
- IDM parameters are literature starting values and have not been calibrated to Maldives traffic.
- Vehicles follow random routes; there are no origin-destination patterns, traffic signals or pedestrians.

## Limits and next steps

1. Calibrate with camera counts, a few days of measured speeds and origin-destination patterns.
2. Run each scenario with many random seeds and report ranges.
3. Add Villimalé and traffic signals.
4. Benchmark the same network in SUMO to show how far the results can be trusted.

## Licence and credits

The code is released under the [MIT License](LICENSE). Street geometry © OpenStreetMap contributors, available under the Open Database Licence (ODbL), so any data derived from it keeps that licence and attribution.
