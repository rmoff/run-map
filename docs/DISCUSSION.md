# run-map — design log

Running notes on UX decisions, dead ends, and open questions. Kept in the repo so it's easy to pick up the thread later.

## Origin

> we're gonna build an app together! pulls in my running data (strava or garmin) and gives me a map of everywhere i've run, and i can zoom in or lasso an area until it shows me just the runs in that area. so when I'm out on the trails and think "when did I run here before" i can find the exactly run.

That's the whole brief. Personal, local, single-purpose.

## Major direction changes

### Stack: Streamlit → FastAPI + Leaflet

Started with **Streamlit + Folium + DuckDB**. Quick to scaffold and got us through the spike, but every map click forced a full Streamlit script rerun, which:
- rebuilt the Folium map, breaking pan/zoom persistence
- flickered the iframe on every interaction
- made highlights / hover tooltips hard to do correctly

Tried Streamlit fragments and various widget-key tricks. Concluded the rerun-on-every-interaction model fights against a map-first UX. Rewrote as a tiny **FastAPI** backend serving a single static page (vanilla JS + Leaflet, no build step). All click → API → mutate DOM, no full reload.

### Strava embed iframe → native preview

Wanted hover-row to show the Strava activity card. Tried `<iframe src="https://www.strava.com/activities/{id}/embed">`. Strava sets `X-Frame-Options: DENY` from third-party origins — there's no public oEmbed endpoint and the official embed URL needs a per-activity token only obtainable from their share UI.

Switched to a **native preview** drawing from `/activities/{id}` and `/activities/{id}/streams`. Renders our own SVG elevation chart. Better UX anyway — looks consistent with the rest of the app, cached forever in DuckDB so re-hover is instant.

### Streamlit hosting → Docker

Container running natively bound to firewalld-blocked port. Switched to Docker — Docker writes its own iptables rules in the `DOCKER` chain, bypassing firewalld, so `-p 8501:8501` makes the LAN reach work without opening firewalld ports.

### DuckDB single connection → per-thread connections

First version held one global DuckDB connection used from all FastAPI threadpool workers. Crashed with `corrupted double-linked list` (glibc memory error) when parallel reads hit it. Wrapped everything in a `threading.Lock` initially — fixed the crash but serialised all DB access, so a long-running background load blocked clicks.

Final form: `threading.local()` — each FastAPI worker holds its own DuckDB connection. DuckDB allows many in-process connections to one file, so parallel reads run concurrently.

### Year-chart filter → removed (pending rethink)

Added a clickable year-bar chart in settings: clicking a year filtered the loaded tracks to that year. Worked, but cluttered the filter model (year vs preset vs polygon vs banner-vs-no-banner). User wants to think about it more cleanly — bar chart stays as a stat visualisation, click-to-filter is gone.

### Bulk-tracks load → aggregate layer + on-demand match polylines

Original design loaded every track on boot and rendered them all as translucent Leaflet features. Two problems converged:

1. **Wire/parse cost.** `/tracks.geojson` was ~13 MB raw / 3.5 MB gzipped, then `JSON.parse` + ~3400 `L.geoJSON` features cost ~1–2 s of main-thread time.
2. **Two visual jobs in one layer.** The stacked-alpha trick was both "give me bearings + clickability" and "show me where I run a lot". It did neither well — overlapping-alpha is a poor heatmap (not a real density function), and 1700 polylines on the same road just looked like noise.

Split into three layers:

- **Aggregate layer** (`/aggregate.geojson`): one deduped MultiLineString of every road/trail you've ever run. Snap-to-grid (~33 m) + pair-segment dedup. Drawn as a single blue Leaflet GeoJSON. Job: bearings + something to click.
- **Heatmap overlay** (`/heatmap.json`, `leaflet.heat`): proper Gaussian-kernel density on densely-sampled points. Job: "I've run this a lot" signal. Toggleable; auto-hides while a match is active because the precise red lines carry the signal once you've zeroed in.
- **Match polylines on demand**: `/match*` ships simplified per-track geometry inline. Client builds Leaflet polylines for the matched set only. No bulk pre-load needed.

Side effect: with no per-track Leaflet features, `snap-to-nearest-track` lock-to-track walks the flat aggregate segment list instead of every loaded layer — same algorithm, simpler data.

### Aggregate ghosting: dropping ST_Simplify

First aggregate implementation ran `ST_Simplify(track, 5e-5)` per track *before* snapping to grid. Looked correct in unit tests but produced visible ghost-parallel lines for the same urban road. Cause: Douglas-Peucker picks different "important" vertices per track based on each track's exact wiggles, so post-snap two runs on the same road end up with different segment endpoint sets. Each contributes its own ghosts.

Fix: drop the simplification. Snap the dense GPS sequence directly. Two runs over the same road traverse the same cell sequence and dedupe cleanly. Total segment count went *up* slightly (110 k vs 80 k) because no DP-pruning, but ghosts went away.

### Heatmap pulses: dedicated /heatmap.json

First heatmap attempt fed `leaflet.heat` from `/index.json` samples — 8 points per track. At running pace that's a point every ~1.25 km, so the Gaussian kernel painted **discrete pulses** along the route instead of a continuous line. Split into a dedicated `/heatmap.json` endpoint with denser sampling (every 8th vertex ≈ every 30 m of real ground), lazy-fetched only when the toggle is on. `/index.json` stays lean for hex aggregation + view-fit + auto-match — those don't need density.

### Disk-cached gzipped responses → sendfile

In-memory caches for the boot blobs only survived until container restart. The first user always paid the full DuckDB-build + JSON-encode + gzip cost. Moved to `_serve_cached(sig, build)`: writes `gzip.compress(body)` to `data/cache/<sig>.json.gz` on first miss, then returns `FileResponse` with `Content-Encoding: gzip`. Starlette uses `sendfile` so Python is out of the loop on warm requests. Cached request: ~4 s → ~7 ms. Filter combos hash to their own cache file.

### Filter chips reintroduced

The year-chart filter was removed pending a rethink (above). Came back, properly: a top-centre **chip bar** with year (multi-select), type (Run/TrailRun), distance min/max. Filters flow as query params through every data endpoint (aggregate, heatmap, index, match) and into the disk-cache key. Persisted in the URL hash (`fyears`, `ftype`, `fmin`, `fmax`) so the working set is shareable.

UX rule that fell out of the discussion: filters narrow the **universe**, the map shows that universe, clicks match within it. One model, not two. The map dims the aggregate layer while a match is active so the red precise tracks lead, but the rest of the filtered universe stays visible as context.

### Settings drawer → split into display popover + data drawer

Settings drawer was a mixed bag: base layer, opacity, heatmap toggle, search radius, lock-to-track, Strava sync, ZIP import. Split by access frequency:

- **🗺 display popover** (new Leaflet control next to ⟲): base layer, opacity, heatmap. Frequent toggles; one click in/one click out.
- **⚙ settings drawer**: search radius, click-behaviour toggles, Strava API, ZIP import, library stats. Infrequent — fine behind a drawer.

## Hard-won UX decisions

- **Reset menu options are zoom criteria, not data filters.** Putting "Last 90 days" in a dismissable banner was wrong because "dismiss" has no clear semantics.
- **Auto-match (single track in view) does NOT change zoom.** The user is browsing; we don't override their viewport. Pin/click does change zoom.
- **Sticky emphasis with preview lock.** Hovering a match row glows the track. Glow persists until another row is hovered or the panel is ×-closed. While the preview is open, hovers can't change the glow — it's pinned. Closing the preview releases the lock.
- **Click marker + radius circle: teal, not red.** Earlier they were red and conflicted with matched tracks. Teal pin (with shadow) sits crisply above red lines.
- **Polygon × on the box itself, not in a banner.** Polygons live in space; the dismiss button belongs in space too.
- **Matches list and embed in a right rail.** Earlier the matches popup was a Leaflet popup at the click point — too easy to obscure the route. Now: top-right floating panel for matches, embed pinned directly below it.
- **Density-by-overlap, not actual heatmap.** Tried Leaflet.heat — beautiful for "where I've been" generally, but for matches the user wants to see individual tracks. Switched to layered translucent red lines: each track stays precise, overlapping segments darken naturally via alpha compositing.

## Visual filter widgets (type + distance)

Two of the three filter inputs were terse form controls (a `<select>` for type, two `<input type="number">` for distance) that didn't show you anything about your library. Replaced both with widgets that double as tiny visualisations of their own dimension:

- **Type**: a `<select>` with three options collapsed into two checkboxes (Road / Trail). Both checked = no filter, which is the visible default — there is no separate "Any" state. Both unchecked also means "no filter" so the user can never silently filter the map to nothing.
- **Distance**: a horizontal histogram of all activities' km, overlaid with a dual-handle range slider. Bars are binned client-side from `indexById` so the picture reflects whatever is currently loaded. The upper handle sitting at the auto-picked cap (5/10/.../300 km, the next nice number above the max observed distance) means "no upper bound" — open-ended. Two overlapping `<input type="range">` elements drive the handles; a separate `#filter-dist-track` div paints the selected band, and the SVG sits behind. No third-party slider library — the native ranges + `pointer-events` discipline keeps the deps unchanged.

The shared pattern: each filter is a tiny visualisation of its own dimension, so picking a value is also seeing the library through that lens.

**Live facet cascade.** The distance histogram re-bins as the user changes date or type *inside the open menu*, before they hit Apply. Implementation: a separate unfiltered `/index.json` snapshot (`_allActivities`) is fetched once at boot and refreshed after ingest. `_renderDistanceHistogram` filters that array by the draft date+type widget state (`_draftOtherFilters`) and rebins. The histogram's own facet (distance) is excluded from the filter so the bars don't move while the user is dragging the handles. Flatpickr's `onChange` and the type-checkbox `change` event drive the re-render; date partial selections (length===1) are ignored to avoid mid-pick flicker.

## Mobile activity-preview carousel

The preview embed (Strava stats + elevation chart + photo) on a phone took most of the viewport and the popup's solid white background sat over the Leaflet toolbar — the user couldn't tap zoom/draw/⟲ without dismissing the embed first.

Two changes:
- The preview content is now split into two `.preview-page` sections (details + elevation, then photo). On desktop they stack as before; on mobile they become a horizontal scroll-snap carousel with two-dot indicator. No JS-driven swipe handler — native `scroll-snap-type: x mandatory` does the work, a small `scroll` listener just toggles the active dot.
- On mobile the right-rail's left edge moved from 12 px to 56 px so the toolbar peeks out alongside the popup. Same vertical real-estate as before; the controls are reachable.

No-photo activities skip the second page and the dots, so the popup stays compact when there's nothing to swipe to.

## Default view = last run + date-range filter

The boot/reset view was three presets (All / Last 90 days / Most traversed area, default `recent90`). In practice the app's single most-used question is "where did I just run", and the multi-preset menu added friction for no gain — none of the other entries got used. Replaced with a single behaviour: ⟲ flies to the bbox of the activity with the latest `start_time`. The whole `applyPreset` / `_activityCentroid` / percentile-IQR machinery is gone.

In parallel the **year multi-select** filter became a **date-range picker** (flatpickr range mode + preset shortcuts Last 7 / 30 / 90 days, This year, All time). Year-as-multi-select couldn't express a window that straddled a year boundary, and the preset shortcuts cover the things people actually want to filter for. The year-bar chart in the stats drawer stays as pure viz.

Cache keys and on-disk filenames now incorporate the date bounds, so each window gets its own gzipped blob just like the year filter used to. Old URL hashes carrying `?fyears=…` are accepted-and-ignored — personal app, no migration needed.

## Aggregate LODs (zoom-keyed)

The aggregate started as one fixed-resolution snap-to-grid (~33 m). It looked fine at z14–15 but was heavier than needed at z11–13 (streets blur together) and too coarse at z16+ (individual trails through fields/woods got blocky). Replaced with three pre-built LODs keyed by zoom band:

- z 11–13 → `low` (~50 m grid)
- z 14–15 → `mid` (~33 m grid)
- z 16+   → `high` (~10 m grid)

Decisions taken while wiring this up:

- **Named bands**, not a numeric `?grid=` param. Server owns the zoom→grid mapping. Means we can tune bands without coordinating a client redeploy, and the cache files-per-filter combo top out at 3.
- **Precompute at ingest**, not lazy. `_warm_default_aggregates()` runs at the tail of import / Strava sync / fix-types — the three no-filter LODs are always warm before the first post-ingest request. Filtered combos stay lazy because filter combinations are unbounded.
- **Snap-to-track always uses the finest LOD.** Snap precision is the kind of thing the user notices viscerally: if click-to-match got coarser when zoomed out, it would feel broken. The client lazy-loads the band needed for display *and* the `high` LOD for snap (one fetch when display is already `high`, two otherwise). Display layer swaps in `applyZoomMode`; `aggregateSegments` stays bound to `high` regardless.

## Performance lessons

- The original `/tracks.geojson` bulk load is gone. Boot now fetches `/index.json` + `/aggregate.geojson` only; per-track geometry rides inline with `/match*` responses.
- Disk-cached gzipped responses served via `FileResponse` + `Content-Encoding: gzip` let Starlette use `sendfile`. Cached request goes from ~4 s (build + gzip + encode) to ~7 ms. Filter combos hash to their own cache file under `data/cache/`.
- The aggregate dedupe key is **`(min(a,b), max(a,b))`** — sorting the pair ensures forwards and backwards runs over the same road collide. Direction-blind by construction.
- Heatmap density needs a **dedicated** dense-sample feed. Reusing the lean per-activity samples produced visible pulses; the kernel needs roughly one point per kernel-radius worth of real ground (~30 m here).

## Things to look at next

- **Year filter, redone.** The chart should stay; clicking a bar should probably scope the *match* set (not the loaded set) or open a side view.
- **Track midpoint** for auto-match marker is just the middle vertex. A better choice would be the geometric centroid projected back to the nearest track vertex.
- **Strava OAuth refresh** runs synchronously inside `/activity/{id}`. If the token's expired, the first preview request blocks for a token roundtrip. Could refresh proactively in the background.
- **Stale activity_details cache.** Kudos/comments don't update because the row is cached forever. Probably want a 24 h TTL for activities <1 week old.
- **Better topo tile**: Thunderforest *Outdoors* has the best look but requires an API key. Worth wiring if you sign up.
- **Sport_type backfill**: previous full Strava sync stored `type='Run'` even for trail runs. Future re-syncs use `sport_type` and will fix it. A one-shot endpoint that pages `/athlete/activities` (sport_type returned in the summary) and updates only the `type` column would fix this in ~9 API calls instead of a full re-sync.

## Filter UX overhaul (2026-05)

The previous filter UI hid every facet behind a single `+ Filter` chip at the top centre. Three problems compounded:

- **Type was over-buried.** Road vs Trail is the single most-grabbed filter, and demanding a pane-open / checkbox-toggle / Apply round-trip for it was friction every session.
- **Apply was overloaded.** The Apply button conflated "narrow what's drawn" with "show me what I just selected." When the user wanted the second, the right-rail never opened — they had to pretend-click somewhere to enter match mode.
- **No way back to a session.** Click → match → reload wiped the selection because the URL hash didn't carry the click marker or the emphasised row.

Resolution:

- **Type pills moved out**, stacked under the funnel button. Both on (default) = no filter; one on = filter to that; both off = a deliberate "All tracks hidden" state with a small notice and every layer dropped. The pills are the source of truth — there is no type chip, and the filter pane no longer has a Type section.
- **Two equal action buttons** in the filter pane: `Filter all tracks` (narrows the aggregate) and `Show matches in view` (renders the filtered set, viewport-bounded, as red match polylines via `/match/polygon` with a bbox WKT). Viewport-bound by construction — matches the mental model of every other interaction (click / rect / hex), keeps response payloads sane, and dodges the "fitBounds zooms below hex threshold and `applyZoomMode` wipes the layers we just drew" edge case.
- **Filter-match mode is sticky.** A new `_filteredMatchActive` flag lets `applyFilters()` re-run the match query when other facets change (pill toggle, distance drag, date pick). Cleared by `clearMatches()` and a fresh location-click.
- **Hover-to-open** popovers for the funnel button + 🗺 button, mirroring each other. A 240 ms grace timer + a "don't close while flatpickr is open" guard keeps date navigation from collapsing the pane.
- **URL persists the active selection.** `cll=lat,lng` carries the click marker, `mid=<id>` the emphasised match. `applyURLState` calls `queryPoint` after data loads and `queryPoint` itself now draws the click pin (so reload + browser-back both restore the pin without a click event).

## Match / aggregate layering

Original code relied on `bringToFront` to keep red match lines above the blue aggregate. That breaks the first time the aggregate LOD swaps after matches are rendered — the new aggregate layer is `addTo(map)`'d *after* the existing match canvas, so it stacks on top. With the canvas renderer in use, "front" within a single pane is decided by draw order, not z-index.

Fix: dedicated panes (`aggPane` z=410, `matchPane` z=450) each with its own `L.canvas` renderer. Aggregate `L.geoJSON` and match polylines/casings route through them. LOD swaps no longer fight match visibility.

## Heatmap toggle reliability

Toggling heatmap on/off/on threw `Cannot read properties of null (reading '_animating')` in `Leaflet.heat`. Cause: re-using a once-removed `L.heatLayer` instance — its internal `requestAnimationFrame` raced its now-null `_map` reference. Fix: always dispose and rebuild the layer in `applyHeatmapVisibility`. The cost is negligible (one render frame) and removes a class of bugs entirely.

Heatmap is also mutually exclusive with active matches; the toggle is now disabled (greyed) while `lastMatches.length > 0` so the inert state is legible. `Show matches in view` clears the heatmap immediately, not after the match fetch resolves.

## Glossary

- **emphasised** — the one matched track currently highlighted (yellow halo). Set by row hover or row click. Released by leaving the matches panel (if nothing pinned) or × close.
- **pinned** — the embed preview is open and locked to a specific activity. Row hovers can't override it. × closes it; mouse hover then drives emphasis again.
- **density mode** — the only match-rendering style. Translucent red lines that stack alpha for overlap visibility.
