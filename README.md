# run-map

A local web app for answering one question: **"when have I run over this spot before?"**

Pulls your runs from Strava, stores them in DuckDB, renders them on a map. Click any point or draw a polygon to find runs that passed through it.

![screenshot placeholder](docs/SPEC.md)

## Run

```bash
docker compose up -d --build
```

Open <http://localhost:8501>.

Data and credentials live in `./data/` (gitignored). Survives `docker compose down`.

## Loading data

Two options:

1. **Strava export ZIP** (recommended for first import) — go to <https://www.strava.com/account>, request your archive, drop the resulting ZIP into the **Import data** section of the settings drawer (⚙). Zero API cost.
2. **Strava API sync** — create an API app at <https://www.strava.com/settings/api> with callback domain `localhost`, paste the client ID/secret into Settings → Strava API, click Authorise, paste back the OAuth code. Then Sync now. Rate-limited (100 calls / 15 min, 1000 / day) so a full backfill takes a while; pick "Last 30 days" or "Last 12 months" for incremental syncs.

Only `Run` and `TrailRun` activity types are imported.

## Using it

- **Click a point on the map** → matched runs appear in a panel top-right. Hover a row to highlight its track; click the run name to pin its Strava preview.
- **Draw a polygon / rectangle** (toolbar top-left) → all tracks intersecting it become matches.
- **Zoom out** → individual tracks give way to an H3 hex heatmap. Click a hex to zoom into its tracks.
- **⚙ bottom-left** → settings: base layer, opacity, search radius, view options, Strava sync, ZIP import.
- **⟲ top-left** → view presets (All / Last 90 days / Most traversed area).

## Stack

FastAPI + DuckDB + Leaflet, packaged in a single Docker container. No build step on the frontend. See [docs/SPEC.md](docs/SPEC.md) for the data model + API surface and [docs/DISCUSSION.md](docs/DISCUSSION.md) for design notes.
