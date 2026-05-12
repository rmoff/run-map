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

## Hard-won UX decisions

- **Reset menu options are zoom criteria, not data filters.** Putting "Last 90 days" in a dismissable banner was wrong because "dismiss" has no clear semantics.
- **Auto-match (single track in view) does NOT change zoom.** The user is browsing; we don't override their viewport. Pin/click does change zoom.
- **Sticky emphasis with preview lock.** Hovering a match row glows the track. Glow persists until another row is hovered or the panel is ×-closed. While the preview is open, hovers can't change the glow — it's pinned. Closing the preview releases the lock.
- **Click marker + radius circle: teal, not red.** Earlier they were red and conflicted with matched tracks. Teal pin (with shadow) sits crisply above red lines.
- **Polygon × on the box itself, not in a banner.** Polygons live in space; the dismiss button belongs in space too.
- **Matches list and embed in a right rail.** Earlier the matches popup was a Leaflet popup at the click point — too easy to obscure the route. Now: top-right floating panel for matches, embed pinned directly below it.
- **Density-by-overlap, not actual heatmap.** Tried Leaflet.heat — beautiful for "where I've been" generally, but for matches the user wants to see individual tracks. Switched to layered translucent red lines: each track stays precise, overlapping segments darken naturally via alpha compositing.

## Performance lessons

- `/tracks.geojson` is ~13 MB raw / ~3.5 MB gzipped. Server-side cache pre-serialises the JSON once and serves bytes directly — cold to warm goes from ~3 s to ~18 ms.
- The remaining bottleneck is **client-side**: `JSON.parse(12 MB)` ≈ 200–300 ms + `L.geoJSON` instantiating ~3400 path features ≈ 1–2 s. Both block the main thread.
- **Viewport-first load** addresses the perceived cold-start: fetch tracks intersecting the saved bbox first, render them, *then* background-load the rest in chunks of 75 features with `setTimeout(0)` yields between chunks. Clicks during the background load are processed between chunks.
- **Don't show a modal spinner for background work.** A small bottom-centre pill ("Loading 600/1700 more tracks…") indicates activity without blocking interaction.

## Things to look at next

- **Year filter, redone.** The chart should stay; clicking a bar should probably scope the *match* set (not the loaded set) or open a side view.
- **Track midpoint** for auto-match marker is just the middle vertex. A better choice would be the geometric centroid projected back to the nearest track vertex.
- **Strava OAuth refresh** runs synchronously inside `/activity/{id}`. If the token's expired, the first preview request blocks for a token roundtrip. Could refresh proactively in the background.
- **Stale activity_details cache.** Kudos/comments don't update because the row is cached forever. Probably want a 24 h TTL for activities <1 week old.
- **Better topo tile**: Thunderforest *Outdoors* has the best look but requires an API key. Worth wiring if you sign up.
- **Sport_type backfill**: previous full Strava sync stored `type='Run'` even for trail runs. Future re-syncs use `sport_type` and will fix it. A one-shot endpoint that pages `/athlete/activities` (sport_type returned in the summary) and updates only the `type` column would fix this in ~9 API calls instead of a full re-sync.

## Glossary

- **emphasised** — the one matched track currently highlighted (yellow halo). Set by row hover or row click. Released by leaving the matches panel (if nothing pinned) or × close.
- **pinned** — the embed preview is open and locked to a specific activity. Row hovers can't override it. × closes it; mouse hover then drives emphasis again.
- **density mode** — the only match-rendering style. Translucent red lines that stack alpha for overlap visibility.
