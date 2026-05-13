# run-map — spec

A local, single-user web app that answers one question on the trail:
**"when have I run over this spot before?"**

## Stack

- **Backend**: FastAPI + DuckDB (with `spatial` extension), serving JSON.
- **Frontend**: vanilla JS + Leaflet + `leaflet-draw` + `h3-js` (no build step).
- **Storage**: a single `runs.duckdb` file in `./data`.
- **Container**: Docker (`docker compose up -d --build`), exposed on port 8501.

## Data model

```sql
CREATE TABLE activities (
    id            BIGINT PRIMARY KEY,    -- Strava activity id
    start_time    TIMESTAMP,
    name          VARCHAR,
    distance_m    DOUBLE,
    moving_time_s INTEGER,
    type          VARCHAR,                -- Run / TrailRun (sport_type)
    strava_url    VARCHAR,
    source        VARCHAR,                -- 'bulk' | 'api'
    track         GEOMETRY                -- LINESTRING WGS84
);

CREATE TABLE activity_details (
    id           BIGINT PRIMARY KEY,
    fetched_at   TIMESTAMP,
    summary_json VARCHAR,                 -- Strava /activities/{id}
    streams_json VARCHAR                  -- altitude + distance streams
);
```

Tracks are simplified at ingest with `shapely.simplify(1e-5)` to ~1 m precision.

## Ingest paths

1. **Bulk import** — read an unzipped Strava export (CSV + GPX/FIT files), filter to `Run`/`TrailRun`, upsert. Zero API cost.
2. **Incremental Strava API sync** — OAuth paste-code flow, `/athlete/activities` + per-activity `latlng` streams. Uses `sport_type` (not the legacy `type`) so TrailRun isn't collapsed into Run. Includes 429 / daily-rate-limit handling.

Both paths use `INSERT … ON CONFLICT (id) DO UPDATE`, so a re-import / re-sync overwrites every field including `type`.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET  | `/`                       | Static index.html |
| GET  | `/aggregate.geojson`      | Single MultiLineString of every road/trail you've run — snap-to-grid (~33 m) + dedupe. The bearings/clickability layer. Filterable. Disk-cached, gzipped, `sendfile`-served. |
| GET  | `/index.json`             | Per-activity samples + bbox + metadata. Feeds the hex overlay, view-fit, auto-match. Filterable. Disk-cached. |
| GET  | `/heatmap.json`           | Densely-sampled lat/lng points (every ~30 m of real ground) for the heatmap overlay. Filterable. Disk-cached. |
| GET  | `/match?lat=&lon=&r=`     | Activities whose track passes within `r` metres of (lat, lon). Includes simplified polyline geometry per match so the client can render the precise red track without holding the bulk track set. Filterable. |
| POST | `/match/polygon`          | Activities whose track intersects the WKT polygon. Form fields: `wkt`, optional filter params. Returns geometry inline as above. |
| GET  | `/filter-options`         | `{years: [...], types: [...]}` — drives the filter-chip add-menu. |
| GET  | `/count`                  | Activity count. |
| GET  | `/stats`                  | `{count, earliest, latest, yearly}` for the library overview. |
| GET  | `/activity/{id}`          | Hover preview — `{summary, streams}`. Fetches Strava `/activities/{id}` + altitude/distance streams on first call, caches forever in `activity_details`. |
| POST | `/import/zip`             | Multipart upload of the Strava export ZIP. |
| GET  | `/strava/status`          | `{has_creds, has_tokens, client_id}` |
| POST | `/strava/config`          | Save client_id/client_secret |
| GET  | `/strava/authorize_url`   | Build the Strava OAuth URL |
| POST | `/strava/exchange`        | Exchange OAuth code for tokens |
| GET  | `/strava/test`            | Call `/athlete` to verify the connection |
| POST | `/strava/sync`            | Run a sync. Form field `range`: "Since last sync" / "Last 30 days" / "Last 12 months" / "From the beginning". |
| DELETE | `/strava/tokens`        | Forget cached tokens |

### Filter params

`/aggregate.geojson`, `/index.json`, `/heatmap.json`, `/match`, `/match/polygon` all accept the same attribute filters:

- `years` — comma-separated list, e.g. `2024,2025`
- `type` — `Run` (road) or `TrailRun`
- `min_km`, `max_km` — distance window in km

Each unique filter combo hashes to its own cache file under `data/cache/`.

DuckDB connections are **per-thread** (`threading.local`), since one connection isn't thread-safe and FastAPI runs sync routes in a threadpool. A shared connection corrupts the native heap under concurrent reads.

## Frontend behaviour

### Layout

- **Map** fills the viewport.
- **Top-left** (Leaflet toolbar): zoom controls, the polygon-draw control, the ⟲ view-reset popover, and the 🗺 display-controls popover (base layer, base opacity, heatmap overlay).
- **Top-centre**: filter chip bar — active year/type/distance chips with × to remove, plus a "+ Filter" button that opens the add-filter menu.
- **Bottom-left**: brand pill (`run-map`) and ⚙ button. Settings drawer slides from the left and now holds only data/click-behaviour controls (search radius, lock-to-track, zoom-to-fit, Strava API, ZIP import, library stats).
- **Top-right (right rail)**: Matches panel (capped at 50 vh) above, Strava-preview panel below. Both pinned with × to dismiss.
- **Top centre toast**: e.g. "Showing runs from the last 90 days…" on first load.

### Boot data flow

On load the page fetches **two** compact blobs:
- `/index.json` — per-activity samples + bbox, used by the hex layer, view-fit and auto-match.
- `/aggregate.geojson` — the deduped "where I've run" line layer.

Per-track geometry is never loaded in bulk. Match polylines arrive inline with `/match*` responses and are built into Leaflet polylines on demand.

### Layer stack

- **z < 11**: H3 hex overlay coloured white→red by activity count per cell. Click a cell to fly-to-bounds of its tracks.
- **z ≥ 11, idle**: aggregate layer (single blue GeoJSON, weight 2.5, opacity 0.85). Optional heatmap overlay (`leaflet.heat`, radius 18, blur 22) on top.
- **z ≥ 11, after click/polygon**: aggregate dims (opacity 0.25) and matched tracks render as translucent red polylines (`STYLE_DENSITY`, weight 4.5, opacity 0.75). Overlapping segments darken naturally via alpha compositing.

The heatmap is **automatically hidden while a match is active** (it's an exploratory overlay; once you've narrowed to specific runs the precise red lines carry the signal). Clearing the matches restores the heatmap if the toggle is on.

### Match interactions

- **Hover row** → yellow halo under a brighter red line; other matches fade to `STYLE_DENSITY_FADED`.
- **Pin** (click row title) → flies to bounds of (single track ∪ click marker), max-zoom 17. Closing the embed restores the pre-pin view.
- **Auto-match**: when a single track is in view (via `/index.json` bbox check), `/match` is called for its midpoint to fetch the precise geometry, and the preview auto-opens. Suppressed after user × dismissal.

### Filters & views

- **View presets** (⟲ menu): *All data*, *Last 90 days* (default on first load), *Most traversed area*. These are **zoom-only criteria**, never data filters.
- **Filter chips** (top-centre bar): year (multi-select), type (Run/TrailRun), distance min/max in km. Filters re-fetch every data endpoint (aggregate, heatmap, index, in-flight matches) and persist in the URL hash.
- **Display popover** (🗺): base layer picker (default OpenTopoMap), base opacity slider (default 50 %), heatmap overlay toggle.
- **Polygon / rectangle draw**: triggers `/match/polygon`, draws precise matched tracks, leaves the polygon outline with a red × close button at its NE corner.
- **Settings drawer** (⚙): search radius (0 = auto / scales with zoom), lock-tap-to-nearest-track, zoom-to-fit-matches, Strava API config + sync, ZIP import, library stats.

### URL state

The URL hash carries: zoom (`z`), centre (`ll`), preset, polygon WKT, lock-to-track toggle, zoom-to-fit, heatmap toggle (`hm`), base layer + opacity, search radius, **and the active filter chips** (`fyears`, `ftype`, `fmin`, `fmax`). Pan/zoom uses `replaceState`; intentional nav (preset change, filter change, polygon draw, hex drill-in, manual click) uses `pushState` so browser back works.

### Performance

- Boot blobs are gzipped and disk-cached at `data/cache/<sig>.json.gz`. The handler returns `FileResponse(..., Content-Encoding: gzip)` so Starlette uses `sendfile` and Python never touches the bytes after the first build. **Cached request: ~7 ms vs ~4 s cold** on a 1700-run library.
- Aggregate sizing on a typical library: ~110 k unique segments, ~800 KB gzipped. Heatmap: ~70 k points, ~1 MB gzipped.
- Match polylines arrive inline with `/match*` responses (simplified via `ST_Simplify` at ~1 m tolerance) — typically <50 tracks, kilobytes-scale.
- Hex bins computed once per H3 resolution and cached on the client.
- Snap-to-nearest-track walks the aggregate segment list — fast because the aggregate is one flat array, no per-track Leaflet layers to traverse.

## Non-goals (current)

- Multi-user, auth beyond personal Strava OAuth.
- Editing activities.
- Pace/HR overlays on the map (shown only in the hover preview).
