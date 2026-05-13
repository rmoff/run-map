# Instructions for Claude working on run-map

## Tests

**Playwright smoke tests must always be kept up to date and run as part of any change** — not as a follow-up.

- The Playwright suite at `tests/test_smoke.py` is the only check that the frontend boots, the map layers render, and click → match still works end-to-end. It catches things unit tests can't (Leaflet init order, layer composition, JS errors during load, popover/chip wiring).
- When you change frontend behaviour, **update the tests in the same commit**: new selectors, new layer state, new interactions. If you remove a UI element, remove the test that targets it; if you add one, add coverage. Don't leave the suite in a "we'll fix it later" state.
- Run `pytest tests/` (against `docker compose up -d --build`) before reporting work complete. Surface pass/fail in the summary.
- The API tests (`tests/test_api.py`) run without a server and are fast — run them after any backend change.

## Stack reminders

- Single-page Leaflet frontend, no build step. Edit `src/run_map/static/{app.js,index.html,style.css}` directly.
- FastAPI backend in `src/run_map/api.py`. DuckDB connections are **per-thread** (`threading.local`) — don't introduce a shared connection.
- Boot data is one-shot from `/aggregate.geojson` + `/index.json` (+ `/heatmap.json` on demand). Per-track geometry only ships inline with `/match*` responses.
- Disk cache lives at `data/cache/<sig>.json.gz`, served by `FileResponse` with `Content-Encoding: gzip`. Always go through `_serve_cached()` for cacheable endpoints; clear via `_invalidate_caches()` on any ingest.

## Docs

When changing data model, endpoints, or major frontend behaviour, update `docs/SPEC.md`. Log major UX or architectural shifts in `docs/DISCUSSION.md` so the thread is easy to pick up later.
