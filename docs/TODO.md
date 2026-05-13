# TODO

Things to come back to. Roughly ordered, but no commitments.

## 1. Make the filters nicer

The current chip-bar popover works but the inputs are blunt:

- **Type**: replace the `<select>` with checkboxes (Road / Trail), so "both" is the visible default rather than "Any" being a separate option. Multi-select reads as "I want these *and* those" rather than a single-pick toggle.
- **Year**: replace the multi-select list with a mini bar chart (one bar per year, height = run count, road/trail stacked). Click a bar to toggle that year in/out; shift-click for a range. Doubles as the existing settings-drawer year chart — kill that duplication.
- **Distance**: replace the two number inputs with a histogram + dual-handle range slider over the actual distance distribution. Quick visual sense of where most runs sit, easy to drag the band.

These are all the same pattern: turn the filter into a tiny visualisation of its own dimension so the user can *see* the library while filtering, not just type numbers.

## 2. Redesign the UI buttons entirely

The current chrome is a pile of accumulated decisions: Leaflet's default zoom controls, polygon-draw control, ⟲ view, 🗺 display, ⚙ settings, chip-bar's "+ Filter". Each was added at a different time and they don't share visual language. Worth a top-to-bottom redesign:

- Coherent icon set (probably a real icon font — Lucide / Phosphor — instead of mixed emoji + Unicode glyphs + Leaflet's CSS-arrow zoom buttons).
- Group by job: navigation (zoom / view-reset), drawing (polygon), display (base layer / heatmap), filters, data/settings.
- Sort out the awkward `🗺` rendering — Leaflet's text-only control isn't a great host for an SVG icon. Either swap to an actual icon DOM, or skin the whole toolbar.

## 3. Zoom-dependent track approximation

Aggregate is currently one fixed-resolution layer (snap-to-grid at ~33 m). Renders fine at city zoom but is overkill at country zoom (hex layer takes over anyway) and could be tighter at street zoom.

Idea: serve **multiple aggregate LODs** keyed by zoom band. Same snap-and-dedupe pipeline, different grid sizes:

| Zoom band | Grid | When |
|---|---|---|
| 11–13 | ~50 m | city / neighbourhood — clean street-map look |
| 14–15 | ~25 m | local roads — current behaviour |
| 16+ | ~10 m | individual paths through fields / woods |

Client picks the LOD on zoomend (with a small debounce) and swaps the layer. Each LOD goes through the existing disk-cache → ~7 ms warm per zoom level. Could also extend to match polylines if/when the wire size becomes a concern (currently fine; tracks are small).

Open question: should LODs be precomputed at ingest time, or lazy-built on first request per band? Lazy-build is simpler and the cache hits would dominate after first load.

## Smaller items (carried forward from the design log)

- **Track midpoint for auto-match** is just the middle vertex; geometric centroid projected to the nearest vertex would behave better on out-and-back routes.
- **Strava OAuth refresh** runs synchronously inside `/activity/{id}` — first hover after token expiry blocks for a roundtrip. Refresh proactively.
- **`activity_details` cache** has no TTL — kudos/comments are frozen at first fetch. 24 h TTL for activities < 1 week old would be enough.
- **Better topo basemap**: Thunderforest *Outdoors* is the nicest looking but needs an API key.
