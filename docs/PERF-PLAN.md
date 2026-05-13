# Performance — done

The original perf plan is fully shipped. Recording the state for future reference.

## What landed

- **Per-track bulk load retired.** Boot fetches only `/index.json` and
  `/aggregate.geojson`. The legacy `/tracks.geojson` endpoint is gone.
- **Aggregate path layer** — single deduped GeoJSON, snap-to-grid (~33 m) +
  pair-segment dedupe (`(a,b)` and `(b,a)` collide on the same key, so
  forwards/backwards runs collapse). No upstream `ST_Simplify` — it was
  picking different "important" vertices per track and producing ghost
  parallel lines.
- **Match polylines on demand** — `/match` and `/match/polygon` ship the
  simplified per-track geometry inline. Match sets are <50 tracks
  typically, so the payload stays kilobytes-scale.
- **Disk-cached gzipped responses** for `/aggregate.geojson`,
  `/index.json`, `/heatmap.json`. `_serve_cached()` writes to
  `data/cache/<sig>.json.gz` and serves via `FileResponse` with
  `Content-Encoding: gzip` — Starlette uses `sendfile` so Python never
  touches the bytes after first build. Filter combos produce additional
  cache entries keyed by signature hash. `_invalidate_caches()` clears
  the dir on every ingest.
- **Filter-aware caching** — `years`, `type`, `min_km`, `max_km` flow
  through every cacheable endpoint and into the cache key.

## Numbers on a 1709-run library

| Endpoint | Cold | Cached |
|---|---|---|
| `/index.json` | ~200 ms | ~7 ms |
| `/aggregate.geojson` | ~4 s | ~7 ms |
| `/heatmap.json` | ~1.5 s | ~10 ms |

Wire sizes (gzipped): aggregate ~800 KB, heatmap ~1 MB, index ~250 KB.

## Things to revisit if the library grows

- **Chained-segment aggregate.** At ~5 k runs the aggregate-segment count
  may push past 250 k. Walking the segment graph to merge co-linear chains
  into longer polylines would cut both wire size and client-side Leaflet
  feature count. Not needed today.
- **Aggregate grid too coarse for parallel paths in fields/forest.** 33 m
  occasionally collapses parallel trail / footpath into one line. If this
  becomes a visible problem (e.g. local woods), revisit — either finer
  grid + more aggressive across-track snapping, or snap-to-OSM-ways.
- **Match polyline encoding.** Inline `[[lat,lng], ...]` arrays cost
  ~30 bytes/point; a Google-polyline-encoded string is ~5× smaller. Only
  worth doing if polygon matches start returning hundreds of tracks.
