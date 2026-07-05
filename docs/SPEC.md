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
    type          VARCHAR,                -- Run / TrailRun / Hike (sport_type; Walk stored as Hike)
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

1. **Bulk import** — read an unzipped Strava export (CSV + GPX/FIT files), filter to the import set below, upsert. Zero API cost.
2. **Incremental Strava API sync** — OAuth paste-code flow, `/athlete/activities` + per-activity `latlng` streams. Uses `sport_type` (not the legacy `type`) so TrailRun isn't collapsed into Run. Includes 429 / daily-rate-limit handling.

**Import set** (shared vocabulary in `activity_types.py`): `Run`, `TrailRun`, `Hike`, `Walk` — all at any distance. Hike and Walk are one activity type — both are stored under the canonical `type` value `Hike`. The hike/walk minimum distance is a **serve-time** gate (`RUN_MAP_HIKE_MIN_KM`, default 5): short hikes are stored but excluded from every map/match/stats query, so changing the threshold needs only a container restart, never a re-import. Note the API-sync cost of importing everything: each walk costs one streams call, so a full-history sync burns quota proportional to your walk count.

Both paths use `INSERT … ON CONFLICT (id) DO UPDATE`, so a re-import / re-sync overwrites every field including `type`. Note that the incremental sync resumes from `max(start_time)` — hikes older than the newest activity in the DB only appear after a "From the beginning" sync or a bulk re-import.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET  | `/`                       | Static index.html |
| GET  | `/aggregate.geojson`      | Every road/trail you've run — snap-to-grid + dedupe, bucketed into three MultiLineString features by visit count (`bucket`: `low` = 1 activity, `mid` = 2–10, `high` = >10; each with a `segment_count`). Feature order low→high so heavy lines draw on top. Three LODs via `?lod=low\|mid\|high` (~50 m / ~33 m / ~10 m), default `mid`. Filterable. Disk-cached (name `aggregate2` — bumped when the payload format changed) per (lod, filter) combo, gzipped, `sendfile`-served. |
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

- `date_start`, `date_end` — ISO `YYYY-MM-DD`, inclusive on both ends; either can be omitted for an open-ended window. Bad input → 400.
- `/match`'s radius is isotropic: longitudes are cos(lat)-scaled on both sides of the `ST_DWithin` test so `r` metres reaches equally far in every direction.
- Every filtered query (and `/stats`) carries a baseline clause excluding hikes below `RUN_MAP_HIKE_MIN_KM`; the threshold is part of every cache signature.
- `type` — `Run` (road), `TrailRun`, or `Hike` (hikes + walks); accepts a comma-separated list (`type=Run,Hike`) which becomes a SQL `IN`. List order doesn't matter — values are sorted before hitting the WHERE clause and the cache signature.
- `min_km`, `max_km` — distance window in km

Each unique filter combo hashes to its own cache file under `data/cache/`.

DuckDB connections are **per-thread** (`threading.local`), since one connection isn't thread-safe and FastAPI runs sync routes in a threadpool. A shared connection corrupts the native heap under concurrent reads.

## Frontend behaviour

### Layout

- **Map** fills the viewport.
- **Top-left** (Leaflet toolbar): zoom controls, the polygon-draw control, the ⟲ reset button (fly to most recent run), the 🗺 display-controls popover (base layer, base opacity, non-matched-track opacity, heatmap overlay), and the funnel button that opens the filter pane. Both popovers open on hover and close after a short grace period when the cursor leaves both the button and the popover.
- **Below the toolbar (left rail)**: always-visible Road / Trail / Hike pills. Click to toggle; all off shows a small "(i) All tracks hidden" notice and removes the aggregate / hex / match layers.
- **Top-centre**: filter chip bar — active date and distance chips with × to remove. Type is carried by the pills, so it gets no chip.
- **Bottom-left**: brand pill (`run-map`) and ⚙ button. Settings drawer slides from the left and now holds only data/click-behaviour controls (search radius, lock-to-track, zoom-to-fit, Strava API, ZIP import, library stats).
- **Top-right (right rail)**: Matches panel (capped at 50 vh) above, Strava-preview panel below. Multi-match results open with a sticky summary line ("N matches · first → last · newest first") and year-separator rows in the table; dismissing polygon-derived matches via the panel's × also clears the drawn polygon. Both pinned with × to dismiss. On mobile (≤700 px) the rail spans top with a 56 px gutter on the left so the Leaflet toolbar stays reachable, and the preview's stats and photo become a two-page horizontal scroll-snap carousel with dot indicators.

### Boot data flow

On load the page fetches **two** compact blobs:
- `/index.json` — per-activity samples + bbox, used by the hex layer, view-fit and auto-match.
- `/aggregate.geojson` — the deduped "where I've run" line layer.

Per-track geometry is never loaded in bulk. Match polylines arrive inline with `/match*` responses and are built into Leaflet polylines on demand.

### Layer stack

- **z < 11**: H3 hex overlay coloured white→red by activity count per cell. Click a cell to fly-to-bounds of its tracks.
- **z ≥ 11, idle**: aggregate layer — worn-path rendering: one dark-navy hue (`#0d3457`, deliberately darker than the basemaps' hydrography blues so tracks never read as rivers), with per-bucket weight/opacity so habitual routes read heavier than one-offs (low 2.0/0.7, mid 2.8/0.85, high 4.0/0.95). Swapped between three LODs by zoom band:
    - z 11–13: `low` (~50 m grid)
    - z 14–15: `mid` (~33 m grid)
    - z 16+: `high` (~10 m grid)
  The client lazy-loads each band on first need; the `high` LOD is always loaded for snap-to-track lookups regardless of display zoom. Optional heatmap overlay (`leaflet.heat`, radius 18, blur 22) on top.
- **z ≥ 11, after click/polygon/filter**: aggregate dims (configurable opacity, default 0.45) and matched tracks render as translucent red polylines (`STYLE_DENSITY`, weight 4.5, opacity 0.75). Overlapping segments darken naturally via alpha compositing.

Aggregate and match layers live in dedicated Leaflet panes (`aggPane` z-index 410, `matchPane` z-index 450) each backed by its own canvas renderer, so matched red lines always render above the aggregate regardless of LOD-swap order.

The heatmap is **automatically hidden while a match is active**, and the toggle in the display popover is greyed out for the duration (it's an exploratory overlay; once you've narrowed to specific runs the precise red lines carry the signal). Clearing the matches re-enables and restores the heatmap if the toggle is on.

### Match interactions

- **Hover row** → yellow halo under a brighter red line; other matches fade to `STYLE_DENSITY_FADED`.
- **Pin** (click row title) → flies to bounds of (single track ∪ click marker), max-zoom 17. Closing the embed restores the pre-pin view.
- **Auto-match**: when a single track is in view (via `/index.json` bbox check), `/match` is called for its midpoint to fetch the precise geometry, and the preview auto-opens. Suppressed after user × dismissal.

### Filters & views

- **Default view + reset** (⟲ button): on boot (no URL view restored) and whenever ⟲ is clicked, the map flies to the bbox of the activity with the latest `start_time` (max-zoom 16). Reset also clears the visible match polylines, matches panel, and Strava embed, but preserves the click marker on the map and the in-memory match-list emphasis so a back-button or pin click can restore the selection.
- **Type pills** (left rail under the funnel): Road, Trail, and Hike (hikes + walks — one pill, one stored type). Click toggles; all on = no type filter, a subset on = comma-list filter of those types, all off = aggregate / hex / matches all hidden with an "(i) All tracks hidden" notice. Pills are the single source of truth for type — there is no type chip. The pill registry (`TYPE_DEFS` in app.js) also drives the match-row icons, tooltips, and the yearly chart colours (road `#1f77b4`, trail `#16a34a`, hike `#d97706`).
- **Filter pane** (funnel button, hover-to-open): three sections — Date (flatpickr range picker with presets: Last month / Last 6 months / Last 12 months, with a Clear-date link), Distance (histogram-backed dual-handle slider; upper handle at the max means open-ended), and an action row with `Clear all` plus two equal-weight buttons: `Filter all tracks` (the previous Apply — narrows the aggregate to this filter set) and `Show matches in view` (renders the filtered tracks that intersect the current viewport as red match polylines via `/match/polygon` with a bbox WKT). The second button is disabled until at least one facet is set, and on click it always clears the heatmap first, regardless of toggle state. While a filter-driven match set is active, toggling a Road/Trail pill (or any other facet) re-runs the match query so the visible set stays in sync.
- **Display popover** (🗺, hover-to-open): base layer picker (Topo / OSM / Light / CyclOSM / Satellite, plus three Thunderforest styles when an API key is saved — `Thunderforest Outdoors` / `Landscape` / `OpenCycleMap`, key stored in `localStorage.runmap.tfApiKey`, saving a key snaps the active base layer to `Thunderforest Landscape`), base opacity slider (default 50 %), non-matched-track opacity slider (default 45 %; controls the dim alpha of the aggregate beneath active matches), heatmap overlay toggle.
- **Polygon / rectangle draw**: triggers `/match/polygon`, draws precise matched tracks, flies to the bounds of the drawn shape (always, even when matches are inside), leaves the polygon outline with a red × close button at its NE corner.
- **Settings drawer** (⚙): search radius (0 = auto / scales with zoom), lock-tap-to-nearest-track, zoom-to-fit-matches, Strava API config + sync, Thunderforest API key, ZIP import, library stats.
- **Esc**: clears the active selection — drops any drawn rect/poly, clears the match set, and removes the click pin / radius circle.

### URL state

The URL hash carries: zoom (`z`), centre (`ll`), polygon WKT (`poly`), lock-to-track toggle (`lock`), zoom-to-fit (`zfit`), heatmap toggle (`hm`), base layer (`base`), base opacity (`op`), search radius (`sr`), non-matched-track dim opacity (`dop`), the active filter chips (`fds`, `fde`, `ftype` — possibly a comma list, `fmin`, `fmax`), and the active click marker + emphasised match (`cll=lat,lng`, `mid=<id>`). Reload restores all of them — `applyURLState` calls `queryPoint(lat,lng)` and `currentEmphasise(mid)` after data loads, and `queryPoint` redraws the click pin + radius circle. The Thunderforest API key is **not** in the URL (it's a secret; localStorage only). Pan/zoom uses `replaceState`; intentional nav (filter change, polygon draw, hex drill-in, manual click, ⟲ reset) uses `pushState` so browser back works. Legacy hashes carrying `preset` or `fyears` are silently ignored.

### Performance

- Boot blobs are gzipped and disk-cached at `data/cache/<sig>.json.gz`. The handler returns `FileResponse(..., Content-Encoding: gzip)` so Starlette uses `sendfile` and Python never touches the bytes after the first build. **Cached request: ~7 ms vs ~4 s cold** on a 1700-run library.
- Aggregate LODs are pre-built at ingest end (`_warm_default_aggregates()` after `_invalidate_caches()`), so the three no-filter variants are always warm post-import / post-sync. Filtered LOD combos remain lazy.
- Snap-to-track always uses the `high` LOD client-side so click precision doesn't degrade at lower zooms.
- Aggregate sizing on a typical library: ~110 k unique segments, ~800 KB gzipped. Heatmap: ~70 k points, ~1 MB gzipped.
- Match polylines arrive inline with `/match*` responses (simplified via `ST_Simplify` at ~1 m tolerance) — typically <50 tracks, kilobytes-scale.
- Hex bins computed once per H3 resolution and cached on the client.
- Snap-to-nearest-track walks the aggregate segment list — fast because the aggregate is one flat array, no per-track Leaflet layers to traverse.

## Non-goals (current)

- Multi-user, auth beyond personal Strava OAuth.
- Editing activities.
- Pace/HR overlays on the map (shown only in the hover preview).
