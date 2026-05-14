# TODO

Things to come back to. Roughly ordered, but no commitments.

## 1. Redesign the UI buttons entirely

The current chrome is a pile of accumulated decisions: Leaflet's default zoom controls, polygon-draw control, ⟲ view, 🗺 display, ⚙ settings, chip-bar's "+ Filter". Each was added at a different time and they don't share visual language. Worth a top-to-bottom redesign:

- Coherent icon set (probably a real icon font — Lucide / Phosphor — instead of mixed emoji + Unicode glyphs + Leaflet's CSS-arrow zoom buttons).
- Group by job: navigation (zoom / view-reset), drawing (polygon), display (base layer / heatmap), filters, data/settings.
- Sort out the awkward `🗺` rendering — Leaflet's text-only control isn't a great host for an SVG icon. Either swap to an actual icon DOM, or skin the whole toolbar.

## Smaller items (carried forward from the design log)

- **Track midpoint for auto-match** is just the middle vertex; geometric centroid projected to the nearest vertex would behave better on out-and-back routes.
- **Strava OAuth refresh** runs synchronously inside `/activity/{id}` — first hover after token expiry blocks for a roundtrip. Refresh proactively.
- **`activity_details` cache** has no TTL — kudos/comments are frozen at first fetch. 24 h TTL for activities < 1 week old would be enough.
- **Better topo basemap**: Thunderforest *Outdoors* is the nicest looking but needs an API key.
