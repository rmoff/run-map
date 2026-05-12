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
| GET  | `/`                    | Static index.html |
| GET  | `/tracks.geojson`      | All tracks as GeoJSON. Params: `from`, `to`, `bbox`, `exclude_bbox`. The no-bbox variant is cached in-process (`_tracks_cache`) and gzipped; cache invalidated on import/sync. |
| GET  | `/match?lat=&lon=&r=`  | Activities whose track passes within `r` metres of (lat, lon). |
| POST | `/match/polygon`       | Activities whose track intersects the WKT polygon. Form fields: `wkt`, optional `from`/`to`. |
| GET  | `/count`               | Activity count. |
| GET  | `/stats`               | `{count, earliest, latest, yearly: [{year, count}]}` for the library overview. |
| GET  | `/activity/{id}`       | Hover preview — `{summary, streams}`. Fetches Strava `/activities/{id}` + altitude/distance streams on first call, caches forever in `activity_details`. |
| POST | `/import/zip`          | Multipart upload of the Strava export ZIP. |
| GET  | `/strava/status`       | `{has_creds, has_tokens, client_id}` |
| POST | `/strava/config`       | Save client_id/client_secret |
| GET  | `/strava/authorize_url`| Build the Strava OAuth URL |
| POST | `/strava/exchange`     | Exchange OAuth code for tokens |
| GET  | `/strava/test`         | Call `/athlete` to verify the connection |
| POST | `/strava/sync`         | Run a sync. Form field `range`: "Since last sync" / "Last 30 days" / "Last 12 months" / "From the beginning". |
| DELETE | `/strava/tokens`     | Forget cached tokens |

DuckDB connections are **per-thread** (`threading.local`), since one connection isn't thread-safe and FastAPI runs sync routes in a threadpool. A shared connection corrupts the native heap under concurrent reads.

## Frontend behaviour

### Layout

- **Map** fills the viewport.
- **Bottom-left**: brand pill (`run-map`) and ⚙ button. Settings drawer slides from the left.
- **Top-right (right rail)**: Matches panel (capped at 50 vh) above, Strava-preview panel below. Both pinned with × to dismiss.
- **Bottom-centre pill**: "Loading N/M more tracks…" while background load is in flight.
- **Top centre toast**: e.g. "Showing runs from the last 90 days…" on first load.

### Tracks rendering

- Two Leaflet GeoJSON layers — casing (white, weight 4, opacity 0.6) under the line (#1a5a8a, weight 2, opacity 0.65). Canvas-rendered (`preferCanvas: true`).
- Below **zoom 11**: hexagon overlay (H3) coloured white→red by run count per cell. Click a cell to fly-to-bounds of the tracks intersecting it.
- At/above zoom 11: tracks visible.

### Matches rendering

- All matched tracks paint as translucent red lines (`STYLE_DENSITY`: weight 4.5, opacity 0.75), casings hidden. Overlapping segments darken naturally via alpha compositing.
- **Hover row** → yellow halo (`STYLE_HOVER_CASING` weight 11, opacity 0.8) under a brighter red line; other matches fade to `STYLE_DENSITY_FADED` (opacity 0.18).
- **Pin** (click row title) → flies to bounds of (single track ∪ click marker), max-zoom 17. Closing the embed restores the pre-pin view.
- **Auto-match**: when a single track is in view, its preview auto-opens at the track midpoint. No zoom change; user view respected. Suppressed after user × dismissal.

### Filters & views

- **View presets** (⟲ menu on map): *All data*, *Last 90 days* (default on first load), *Most traversed area*. These are **zoom-only criteria**, never data filters.
- **Polygon / rectangle draw**: triggers `/match/polygon`, highlights intersecting tracks, leaves polygon outline drawn with a red × close button at its NE corner.
- **Settings (⚙)**: lock-tap-to-nearest-track (default on), zoom-to-fit-matches (default off), base layer picker (default OpenTopoMap), base opacity slider (default 50 %), search radius slider (0 = auto / scales with zoom, > 0 = explicit metres), apply button to re-run query at current click.

### URL state

The URL hash carries: zoom (`z`), centre (`ll`), preset, polygon WKT, lock-to-track toggle. Pan/zoom uses `replaceState`; intentional nav (preset change, polygon draw, hex drill-in, manual click) uses `pushState` so the browser back button works.

### Performance

- `/tracks.geojson` cache + gzip: cold ~2.8 s → warm ~18 ms.
- Viewport-first load: foreground fetches only the bbox subset; remaining tracks stream in the background in chunks of 75 with main-thread yields, so clicks during the load stay responsive.
- Hex bins computed once per H3 resolution and cached.

## Non-goals (current)

- Multi-user, auth beyond personal Strava OAuth.
- Editing activities.
- Pace/HR overlays on the map (shown only in the hover preview).
- Year-based data filtering (removed, pending a rethink — see [DISCUSSION.md](DISCUSSION.md)).
