# run-map — UX audit

Fresh-eyes audit per `docs/superpowers/specs/2026-05-14-ux-audit-design.md`.
Severity tags: `nit` (cosmetic), `friction` (slows you down), `confusing` (misleads or wastes a click), `broken` (does the wrong thing or nothing).
Screenshots live under `docs/img/ux-audit/`. Mockups for Pass 3 live under `docs/img/ux-audit/mockups/`.

---

## Pass 1 — Desktop narrative

Auditor approached the app fresh at 1440×900 with no prior knowledge of the controls. Findings below capture every place an icon, label, or behaviour failed to match expectations on first contact. Console was clean apart from a 404 on `/favicon.ico` (cosmetic, not user-visible).

### D1. The "⟲" icon does not mean what it usually means `confusing`

![](img/ux-audit/desktop-hover-reset.png)

The third toolbar button is a curved-arrow glyph (1). Every other web map I have used puts a refresh/undo/reset-view icon in roughly that slot — clockwise or counter-clockwise arc means "go back to the original view". Clicking it actually flies to the most recent run (its `title` attribute confirms this once you discover hover-text doesn't render, see D2). The icon is borrowed from "reload" but the action is "fly to newest". A globe / target / play-arrow / GPS-pin icon would communicate "go to latest" far better; the curved arrow specifically suggests "undo my zoom".

**Observation:** ⟲ reads as "reset view" but actually flies to the most recent run — wrong mental model.

### D2. Toolbar icons have HTML `title` text but no visible tooltip on hover `friction`

![](img/ux-audit/desktop-hover-zoom-in.png)

Hovering the toolbar produces no on-screen tooltip even after a 2-second dwell (1) — this screenshot is mid-hover on the zoom-in button. The `title` attribute IS set (e.g. "Fly to most recent run", "Display", "Filter"), so the browser default tooltip eventually appears, but with the standard ~1s delay and as a tiny native OS bubble that's easy to miss. There is no custom styled tooltip. Combined with D1, this means a fresh user has to click every icon to learn what it does. The ⚙ Settings button (bottom-left) at least has `aria-label="Settings"` but no visible label either.

**Observation:** No styled tooltips — discoverability of icon-only controls relies on the OS-level `title` delay.

### D3. The 🗺 emoji on the "Display" toggle is ambiguous with the basemap `friction`

![](img/ux-audit/desktop-display-open.png)

Clicking the 🗺 button opens a panel containing: Base layer dropdown (1), Base opacity (2), Non-matched track opacity (3), Heatmap overlay (4). I expected a "switch basemap" picker; the actual surface is broader (it controls opacity of *both* layers and toggles the heatmap). The label "Display" is in the title text but not on the button. A user who wants to dim track lines is unlikely to guess that's behind the 🗺 icon — it reads as "change map style", not "configure rendering".

**Observation:** 🗺 implies basemap-picker, but the panel is actually a render-controls hub (basemap + opacities + heatmap).

### D4. Two filter action buttons with overlapping labels `confusing`

![](img/ux-audit/desktop-filter-open.png)

The filter pane (1) ends with **two** primary actions side-by-side: "Filter all tracks" and "Show matches in view" (2). Reading the labels alone: both contain "filter/matches", both apply to "tracks/view". The second is disabled until a match is active (no inline hint why). The right tooltip (after-the-fact) explains "Filter all tracks → Narrow the aggregate map to this filter set" and "Show matches in view → Render filtered tracks within the visible map area as red match polylines" — that's the kind of explanation that needs to be on the button or in a helper line, not buried in `title`. A fresh user has to A/B test to learn the difference.

**Observation:** "Filter all tracks" vs "Show matches in view" — labels don't differentiate; the second's disabled-state has no reason given.

### D5. Heatmap toggle silently disables itself when a match is shown `confusing`

![](img/ux-audit/desktop-heatmap-vs-match.png)

With heatmap turned on, clicking the map to fetch matches replaces the heatmap with red match polylines (correct), but the Heatmap-overlay checkbox in the Display popover remains **checked AND becomes disabled** with no visual cue inside the popover. The user toggled it on, can no longer toggle it off, and the heatmap they expected to see is gone — replaced by something they don't yet realise is mutually exclusive. No inline message like "Heatmap hidden while showing matches".

**Observation:** Heatmap and matches are mutually exclusive but the UI doesn't say so — the checkbox lies (still says "on") and goes un-clickable.

### D6. Esc clears the match panel and the pinned track but leaves the click-marker URL state `nit`

![](img/ux-audit/desktop-after-esc.png)

After pinning a match and pressing Escape: the right detail panel, the orange pinned polyline, and the match list all disappear (good). But the URL still contains `&cll=53.91612%2C-1.80442` from the original click. There's no visible click-marker on the map either, so nothing tells me state remains. If I share the URL or hit refresh, the matches re-open. Either the click marker should remain visible, or Esc should also strip `cll` from the URL.

**Observation:** Escape clears UI but leaves the click coordinate in the URL hash — invisible state.

### D7. Match-row table has no header or summary `friction`

![](img/ux-audit/desktop-map-click.png)

After clicking the map (1), a panel of matched tracks appears (2). It's a bare table with date / distance / title columns — no header explaining "4 matches near your click", no sort options, no indication of which column is sortable. Date and distance are linkified to Strava (good); title is a separate link that pins the track on the map (also good, once you know). But nothing tells me clicking the title pins vs clicking the date opens Strava — these are visually identical underlined links.

**Observation:** Match list has no header/count, and two link styles per row mean the same thing visually but behave differently.

### D8. Match row "Open on Strava" vs "pin" — same look, different actions `confusing`

![](img/ux-audit/desktop-match-pinned.png)

After clicking the title link, the right-hand pinned panel appears (1) with photo, stats, and an explicit "Open on Strava ↗" link at the top. So the pinned detail panel does the disambiguation properly. But the **match list rows themselves** still show date + distance as `<a href="strava.com/...">` and the title as `<a href="#">` — three identical-looking underlined links per row with two different destinations. New user has to click to discover.

**Observation:** In each match row, two of the three links go to Strava and one pins the track — they are visually identical.

### D9. Polygon-draw arming uses Leaflet.draw's default tooltip — tiny and behind the toolbar `friction`

![](img/ux-audit/desktop-polygon-armed.png)

Arming the polygon tool produces a small instruction tooltip at the top-left (1) — "Click to start drawing shape" with secondary Finish / Delete last point / Cancel controls. The text is small (default Leaflet.draw styling), low contrast against the basemap, and partially overlaps the toolbar itself. There's no clear "you are now in drawing mode" affordance — the polygon-draw button doesn't get an active highlight. If a user accidentally arms it then clicks elsewhere, nothing obvious tells them they're still armed.

**Observation:** Polygon-armed state relies entirely on tiny default Leaflet.draw chrome — no body-level cursor change or button highlight indicates "drawing mode active".

### D10. Settings drawer overlaps the map and is left-aligned, while its trigger is bottom-left `nit`

![](img/ux-audit/desktop-settings-open.png)

The ⚙ button lives in the bottom-left corner. Clicking it slides a drawer in **from the left** (1) that covers ~25% of the map width. That is the same edge as the toolbar — the drawer covers the toolbar too. Two friction points: (a) the trigger is bottom-left but the drawer expands upward and rightward, which feels unanchored; (b) the toolbar buttons become inaccessible while the drawer is open. A right-side drawer (opposite the toolbar) or an anchored popover near the gear would be cleaner.

**Observation:** Settings drawer overlays the toolbar and isn't visually anchored to the ⚙ trigger.

### D11. Settings drawer mixes "session preferences" with "destructive admin actions" `confusing`

![](img/ux-audit/desktop-settings-strava.png)

Scrolling the drawer reveals: Your library stats; Click behaviour (search radius, lock-to-nearest, zoom-to-fit) (1); Thunderforest API key entry; Strava API credentials + Sync now + Forget tokens; Import Strava export ZIP (2). That's three very different audiences mashed together: ephemeral UI prefs, third-party credentials, and a one-time bulk import. A fresh user opening "Settings" expects preferences, not an OAuth credentials form. The Strava sync controls in particular feel like they belong in a dedicated admin route, not behind the same gear as "zoom to fit matched tracks".

**Observation:** Settings drawer mixes session prefs (cheap, reversible) with API credentials and bulk import (expensive, irreversible).

### D12. "Search radius: auto" with a 0-valued slider and an Apply button `confusing`

![](img/ux-audit/desktop-settings-open.png)

Inside Click behaviour: a slider labelled "Search radius: auto" sits at value 0 alongside an Apply button (1). The label says "auto" but the slider is at the minimum — there's no indication of what dragging it would do, what units (meters? pixels?), what range, or why "Apply" is needed instead of live-update like every other slider in the Display popover. The two checkboxes below (Lock tap to nearest track / Zoom to fit matched tracks) update immediately, so this Apply-button slider is inconsistent with its neighbours.

**Observation:** The "Search radius" slider is the only control that needs an Apply click; units and range are not labelled.

### D13. Activity-type pills don't look like toggles `nit`

![](img/ux-audit/desktop-trail-only.png)

Top-left under the toolbar are two stacked pills "Road" and "Trail" — both visually identical when both active and when one is deactivated, except for a subtle colour tint. At a glance I assumed they were tabs (single-select). They are actually independent toggles (multi-select on by default). The triangle-down disclosure under them (1) — purpose unclear, possibly opens a date-band filter? — adds noise.

**Observation:** Road/Trail pills look like tabs but act like checkboxes; the disclosure caret below has no obvious function.

### D14. Chip × is a plain `<span>`, not a button `nit`

![](img/ux-audit/desktop-filter-applied.png)

The filter chip at top-centre (1) shows "2025-05-14 → 2026-05-12 ×". Removing the filter requires clicking the small × glyph. Inspecting its markup: it's `<span class="x" title="Remove">×</span>` — not a `<button>`, no focusable tab-stop, no accessible role, and a small click target (~12px) sitting flush against the date text. Clicking the chip body does nothing — only the × works. The "Remove" tooltip only shows via OS title hover.

**Observation:** Chip × is a non-focusable span with a tight click target; only it (not the chip body) clears the filter.

### D15. Reload restores filter and pin, but not the pinned detail panel `friction`

![](img/ux-audit/desktop-after-reload.png)

Loading a deep URL with `mid=...` re-renders the orange pinned polyline (1) and the match list (2), but the right-hand pinned detail panel (the one with photo, stats, Strava link from D8) is NOT restored. A user who shares a URL gets a partial state — the match is shown on the map but the detail card a click would have revealed is missing. Either auto-open the detail panel from `mid`, or remove `mid` from the URL when the detail panel closes — currently the state is half-persisted.

**Observation:** Deep-link with `mid` restores the highlighted match but not the detail card, so reload silently loses information.

### D16. ⚙ Settings is the only bottom-left control; everything else is top-left `nit`

![](img/ux-audit/desktop-boot.png)

On boot the toolbar stack is at top-left, the activity-type pills are below it, and the lone ⚙ button is in the bottom-left corner — far away. Visually it doesn't feel like part of the same control system. Combined with D10 (the drawer slides out next to the toolbar, not the gear), there's no clear "controls live here" region.

**Observation:** Spatial grouping is inconsistent — ⚙ is detached from the rest of the chrome and from its own drawer.

### D17. URL hash uses cryptic short keys `nit`

The URL after applying state looks like `#z=15&ll=53.91637%2C-1.79882&fds=2025-11-13&fde=2026-05-12&ftype=TrailRun&cll=53.91744%2C-1.80200&mid=18472657487&hm=1&base=OpenStreetMap&op=80`. Keys: `z, ll, fds, fde, ftype, cll, mid, hm, base, op`. A user copy-pasting / hand-editing the URL has no way to know that `fds`/`fde` are filter date start/end, `cll` is click lat-lng (vs `ll` map centre), `mid` is match id, `hm` is heatmap, `op` is opacity. Not a fresh-user blocker but a friction for anyone debugging or sharing.

**Observation:** Hash params are unguessable abbreviations.

### D18. Hex cells at low zoom are silent — clicking does nothing visible `confusing`

![](img/ux-audit/desktop-sweep-hex-cells.png)

Zooming out to z≈8 swaps the per-track lines for an aggregate hex-cell layer (semi-transparent blue/teal polygons). There is no legend, no count, no key telling a user what the hex colour intensity means (run count? distance?), and **clicking a cell produces no response** — no tooltip, no popover, no count, no flyout (`desktop-sweep-hex-click.png` is indistinguishable from the no-click state). Compared with z>11 where clicking the map opens a match list, the low-zoom interaction model is silently different. A user who taps a cell expecting "show me runs in this area" gets nothing.

**Observation:** Hex aggregate cells at z<11 have no legend and are not interactive — clicking is a no-op.

### D19. Turning both activity pills off hides every track silently `confusing`

![](img/ux-audit/desktop-sweep-pills-both-off.png)

Deactivating both Road and Trail pills removes every aggregate track from the map (correct), but there is no inline notice — no banner, no "(i) All tracks hidden — re-enable Road or Trail" message, no greyed-out empty-state overlay. The basemap is the only thing left. A user who toggled both off (e.g. to compare just heatmap) sees an empty map and may assume the app broke. The spec hinted at an "All tracks hidden" notice but it isn't rendered.

**Observation:** Both-pills-off state silently empties the map — no empty-state messaging.

### D20. No "run-map" brand pill is rendered `nit`

The Pass 2 checklist expected a `run-map` brand label at bottom-left, but inspecting the DOM shows no element with that text and no `.brand` / `.logo` node. The bottom-left contains only the ⚙ Settings button (D10/D16). Either the brand was removed at some point or it never existed in this build — there is currently no app-level identification on screen, which is a minor wayfinding gap when the page is one of many tabs.

**Observation:** No visible app brand/name anywhere in the UI chrome.

---

## Desktop coverage-checklist sweep

- Zoom + control — covered by D2 (`desktop-hover-zoom-in.png`).
- Zoom − control — covered implicitly by Pass 1 (`desktop-click-zoom-in.png`); same control family as +.
- Polygon-draw control — covered by D9 (`desktop-polygon-armed.png`, plus `desktop-polygon-drawn.png` / `desktop-polygon-closed.png`).
- ⟲ reset button — covered by D1 (`desktop-hover-reset.png`, `desktop-click-reset.png`).
- 🗺 display popover (base layer / base opacity / non-matched opacity / heatmap toggle) — covered by D3 + D5 (`desktop-display-open.png`, `desktop-display-opacity.png`, `desktop-display-baseswitch.png`, `desktop-heatmap-on.png`).
- Funnel / filter pane (date, distance, action row) — covered by D4 (`desktop-filter-open.png`, `desktop-filter-applied.png`).
- ⚙ settings drawer — covered by D10–D12 (`desktop-settings-open.png`, `desktop-settings-strava.png`, `desktop-settings-bottom.png`).
- ❌ Brand pill (`run-map` label, bottom-left) — not present in the DOM. Logged as **D20** (discoverability/brand gap).
- Road / Trail pills (both on, one off) — covered by D13 (`desktop-trail-only.png`).
- ⚠️ Road / Trail pills both off + "(i) All tracks hidden" notice — narrative did not test this; captured in `desktop-sweep-pills-both-off.png`. The "All tracks hidden" notice does **not** render — logged as **D19**.
- Filter chip bar (date chip, distance chip, × dismiss) — covered by D14 (`desktop-filter-applied.png`, `desktop-filter-chip-removed.png`).
- Matches panel (capped at 50 vh, × dismiss) — covered by D7 (`desktop-map-click.png`); a `#matches-close` × button confirmed in DOM at top-right of the panel.
- Strava preview panel (× dismiss) — covered by D8 (`desktop-match-pinned.png`); a `#preview-close` × button confirmed in DOM.
- Click → match (with click marker + radius circle) — covered by D7; click marker / radius circle visible in `desktop-map-click.png` and `desktop-sweep-click-marker.png`.
- Polygon close × button at NE corner of the polygon — covered by `desktop-polygon-closed.png` referenced from D9.
- ⚠️ Hex cells at low zoom (z<11) — narrative never zoomed out; captured in `desktop-sweep-hex-cells.png` and `desktop-sweep-hex-click.png`. Clicking a hex is a silent no-op — logged as **D18**.
- Heatmap auto-hide while match is active (toggle greyed) — covered by D5 (`desktop-heatmap-vs-match.png`).
- Esc clears selection — covered by D6 (`desktop-after-esc.png`).
- URL reload restores state — covered by D15 (`desktop-after-reload.png`).
- Browser back across navigation — covered by Pass 1 setup (`desktop-after-back.png`).

**Summary:** 3 items needed new capture (pills-both-off, hex cells at low zoom, hex click). 3 new findings added (D18 hex-click silent / no legend; D19 both-pills-off has no notice; D20 no brand pill). 1 item (brand pill) is confirmed unreachable — it doesn't exist in this build.

---

## Pass 1 — Mobile narrative

Auditor approached the app fresh at 390×844 (iPhone 12/13/14 portrait), no prior knowledge of the mobile layout. The console at boot was clean — same two `Password field is not contained in a form` verbose notes seen on desktop, no errors or warnings. Findings below focus on places where mobile diverges from desktop or where the smaller viewport amplifies a known issue.

### M1. Activity-type pills land on top of the toolbar buttons `broken`

![](img/ux-audit/mobile-boot.png)

This is the single most visible mobile-only defect at boot. The vertical toolbar stack lives at x=10–44 with five buttons running from y=10 to y=278 (Zoom +, Zoom −, Polygon, Rectangle, ⟲ Reset, 🗺 Display, Filter). The Road/Trail activity pills are positioned absolutely at x=10, y=200 and y=227 — **directly on top of the 🗺 Display button (y=204–234) and overlapping the Filter button (y=248–278)**. The pills sit in the same x range (10–67) as the toolbar (10–44), so the pills physically cover two icon controls. On the boot screenshot (1) you can see the "Road" pill sitting where the Display 🗺 icon should be — the icon is not visible at all. The 56 px gutter that the spec promises between the left toolbar and the right-side rail does not exist; instead there's a 0 px gutter where left-stacked chrome collides with itself. Tapping either Road or the 🗺 button at that location is essentially a coin flip.

**Observation:** Road/Trail pills are absolutely positioned on top of two toolbar buttons — the Display and Filter icons are unreachable until a pill is hidden or moved.

### M2. (Same as D1, D2) ⟲ icon + missing tooltips — worse on mobile

![](img/ux-audit/mobile-toolbar-vs-rail.png)

On desktop (D1, D2) the ⟲ button reads as "reset view" rather than "fly to most recent" and there are no styled tooltips. On mobile the issue is amplified: there is no hover state at all — a tap commits the action. Combined with M1 (pills occluding Display and Filter), the only way to learn what any toolbar button does is to tap it and watch the map react. The OS-level `title` tooltip that rescues D2 on desktop simply doesn't exist on touch.

**Observation:** Icon-only toolbar with no tooltip is bad on desktop, worse on touch where there is no hover-to-disambiguate fallback.

### M3. Filter popover takes the full viewport width `friction`

![](img/ux-audit/mobile-filter-open.png)

The filter popover renders at x=12, y=8, width=366, height=337 — covering essentially the entire upper half of the screen (1). It is anchored to the Filter toolbar button but the button itself sits underneath the popover. There is no × close on the popover; tapping outside or hitting the Filter button again toggles it. The popover content (date presets, distance, two action buttons) does fit, but the "Filter all tracks" / "Show matches in view" pair (D4) inherits the same labels-don't-discriminate problem and now those two buttons are side-by-side at the bottom of a panel that occupies most of the screen, raising the cost of an exploratory tap.

**Observation:** Filter popover behaves as a quasi-full-screen sheet without sheet affordances (no drag handle, no header, no × close).

### M4. Display popover sits on top of the Filter button it didn't open from `confusing`

![](img/ux-audit/mobile-display-open.png)

Opening the 🗺 Display popover anchors it at x=12, y=240, width=255, height=264 — so it extends down to y=504 (well into the map). The Filter toolbar button at y=248–278 ends up underneath the popover. A user who opens Display and then wants to also open Filter has to dismiss Display first. There is again no × on the popover.

**Observation:** Mobile popovers don't dodge the toolbar — they cover sibling buttons.

### M5. Settings drawer covers ~92% of the viewport with no visible map underneath `friction`

![](img/ux-audit/mobile-settings-open.png)

On desktop (D10, D11) the drawer is a left-edge slab that covers ~25 % of the map and feels detached from its trigger. On mobile the same drawer at 359 of 390 px occupies 92 % of the viewport — basically a full-screen sheet, but again with no drag handle, no "Done" affordance, only a small × at top-right. Inside, the Click-behaviour section (D12), Thunderforest credentials, Strava OAuth, and Strava import (D11) are all stacked in a single long scroll. On a phone this means a user opening Settings to toggle "Zoom to fit matched tracks" is two finger-scrolls away from a destructive "Forget tokens" button. The Search-radius slider (D12) renders correctly but the Apply button (60 × 27 px) is below the minimum recommended touch target.

**Observation:** Settings is a full-screen sheet without sheet conventions; safe and destructive controls share the same scroll, which is a bigger risk on touch where mis-taps are common.

### M6. Matches panel hard-wraps against the toolbar with no breathing room

![](img/ux-audit/mobile-map-click.png)
![](img/ux-audit/mobile-matches-toolbar-overlap.png)

After a map tap, the matches panel renders at x=56 (right against the toolbar at x=10–44, with a 12 px gap), y=12, width=322, height=320. That's 82 % of viewport width — fine — but the panel pushes flush against the toolbar with no margin. More importantly the matches panel header gives no count and no sort affordance (same as D7) and the table column widths squash on the smaller viewport: the title column is only ~107 px wide so most run names wrap to two or three lines (e.g. "Punk Panther Wharfedale Skyline", "Splashing around the moor in my grippy s…" gets truncated mid-word). Identical-looking link styles (D8) for two-different-destinations are still present and even more confusing when each row is now 3 lines tall.

**Observation:** Matches panel docks against the toolbar with no gutter; small viewport amplifies the D7/D8 link-ambiguity issue.

### M7. Strava preview carousel — dots are 6×6 px and hard to tap or even see

![](img/ux-audit/mobile-preview-page1.png)
![](img/ux-audit/mobile-preview-page2.png)

Tapping a match title opens the preview below the matches panel. It is a horizontally scrolling carousel of two pages: page 1 (details, stats, "Open on Strava ↗" link) and page 2 (photo). Scroll-snap works correctly and the photo fits within the viewport on page 2. **But** the dot indicators at the bottom of the carousel are 6 × 6 px spans (1) with 6 px gap, at y=685 — they read as decoration rather than a control. They are also non-interactive: tapping a dot does not jump pages, the user must horizontal-swipe. On a 390 px viewport with the matches panel taking the top half and the carousel taking the bottom half, the user gets *two* nested vertical scroll areas (matches list, page 1 details) plus a horizontal scroll (preview pages) all interleaved — a recipe for accidental scroll-direction collisions.

**Observation:** Carousel dots are 6 px static decorations, not tap targets; nested scroll regions (vertical-in-vertical-with-horizontal) on a phone is fragile.

### M8. Preview pushes the matches panel into a tiny scroll port

![](img/ux-audit/mobile-match-pinned.png)

With the matches panel at y=12 height=320 and the preview at y=340 height=359, plus the top URL bar, basically the entire viewport is consumed by chrome. The map is no longer visible beneath the chrome — the user has lost their place. There is no resize handle to give more of the screen to either panel, and the preview is not modal so it doesn't *replace* the matches list, it stacks below it.

**Observation:** When a match is pinned, the entire viewport is panels; the map (the actual subject of the app) is hidden.

### M9. ⚙ Settings button is bottom-left, in the thumb hot-zone — but everything else is bottom-far `nit`

![](img/ux-audit/mobile-boot.png)

On a 390 × 844 phone the ⚙ button (12, 786, 40 × 42) is well placed for thumb-reach — bottom-left is one of the easiest spots to hit on a one-handed phone hold. **However**, all the controls the user actually needs (toolbar buttons, pills, filter chip) live at the *top* of the screen, in the hardest-to-reach zone. The frequency-vs-reachability is inverted: the rarely-used Settings gear is reachable, the constantly-used Zoom/Display/Filter buttons are not. The matches panel × button (340, 20, 34 × 42) and preview × (340, 349, 34 × 42) are top-right — the worst spot for a right-handed thumb.

**Observation:** Critical controls live in the top-left and top-right corners — both awkward thumb zones — while the bottom of the screen is largely empty.

### M10. Filter chip × is even smaller than on desktop and now also collides with toolbar `friction`

![](img/ux-audit/mobile-filter-applied.png)

The filter chip "2025-11-13 → 2026-05-12 ×" sits at x=100, y=8, height=26 (1). On desktop (D14) the × was already a small `<span>`; on mobile the chip's height is only 26 px and the × glyph is roughly 12 px wide pressed flush against the date text. To clear the filter the user must hit a sub-15 px target, well below Apple's 44 × 44 minimum and Google's 48 × 48. Worse, the chip sits at y=8 — the exact strip the matches panel × button also occupies (y=20, x=340) when matches are open — so the user has *two* tiny dismiss × buttons within 30 px of each other along the top edge.

**Observation:** Chip × glyph is ~12 px on a touch device — well under any mobile tap-target guideline.

### M11. (Same as D9) Polygon-draw default tooltip is unreadable at 390 px

![](img/ux-audit/mobile-polygon-armed.png)

Arming the polygon control surfaces Leaflet.draw's default tooltip "Click the first point to close this shape" at the very top of the map. The Cancel/Finish actions are crammed onto a narrow strip below the toolbar (1). On desktop (D9) this was small but legible; at 390 px it overlaps the matches/filter-chip strip and becomes essentially unreadable. The polygon button gets no active highlight, so the only signal "you are drawing" is the tiny tooltip that occupies the same strip as the filter chip.

**Observation:** Polygon-arming chrome is sized for desktop and doesn't reflow at 390 px.

### M12. (Same as D19) Both pills off — silent empty map, no signal

![](img/ux-audit/mobile-pills-both-off.png)

Same behaviour as desktop. On mobile the problem is worse because the pills are buried under the Display button (M1), so a user who *finds* the pills and turns them both off has no way of knowing why the map went blank — and no inline message appears. The empty state shows the basemap with the filter chip still visible at top (1) but no track data.

**Observation:** Empty-state message that was missing on desktop is also missing on mobile, where the trigger is harder to find and harder to undo.

### M13. No mobile-specific bottom bar / sheet pattern — everything is desktop-shrunk

A general observation: nothing about this layout is mobile-native. There is no bottom navigation bar, no bottom sheet for matches/preview (the standard iOS Maps / Google Maps pattern), no drag handle, no swipe-to-dismiss on the preview or matches panel, no half/full sheet detents. Each surface is a desktop popover or modal scaled down. For a map app, where 99 % of the screen should be the map, the mobile experience reads as "desktop site that fits".

**Observation:** Mobile chrome is desktop chrome at 390 px — no platform-native sheet/bottom-bar pattern.

---

## Mobile coverage-checklist sweep

- Zoom + control — ✅ covered by M1/M2 (`mobile-boot.png`, `mobile-toolbar-vs-rail.png`); same icon-only failure as desktop, amplified by lack of hover (M2).
- Zoom − control — ✅ same family as Zoom + (`mobile-boot.png`).
- Polygon-draw control — ✅ covered by M11 (`mobile-polygon-armed.png`); arming chrome unreadable at 390 px.
- ⟲ reset button — ✅ covered by M2 (`mobile-toolbar-vs-rail.png`); same icon mismatch as D1.
- 🗺 display popover — ✅ covered by M4 (`mobile-display-open.png`); popover covers the Filter toolbar button.
- Funnel / filter pane — ✅ covered by M3 (`mobile-filter-open.png`); quasi-full-screen sheet without sheet affordances.
- ⚙ settings drawer — ✅ covered by M5 (`mobile-settings-open.png`); 92 % of viewport, no drag handle.
- ❌ Brand pill — not present (re-confirmed on mobile via DOM query: no `.brand` / `.logo`, no `run-map` text node in chrome). Same conclusion as desktop **D20**.
- Road / Trail pills (both on) — ✅ covered by M1 (`mobile-boot.png`).
- Road / Trail pills (one off) — ✅ covered by inheritance from D13 (same control); the **mobile-only** defect is M1 (pills overlap toolbar) — see also **M14** for "one-off" tap risk.
- Road / Trail pills (both off) — ✅ covered by M12 (`mobile-pills-both-off.png`).
- Filter chip bar — ✅ covered by M10 (`mobile-filter-applied.png`); ~12 px × glyph below tap-target guidelines.
- Matches panel × dismiss — ✅ covered by M6 (`mobile-map-click.png`, `mobile-matches-toolbar-overlap.png`); `#matches-close` confirmed in DOM at top-right of panel.
- Strava preview panel × dismiss — ✅ covered by M7/M8 (`mobile-preview-page1.png`, `mobile-preview-page2.png`, `mobile-match-pinned.png`); `#preview-close` confirmed in DOM.
- Click → match (click marker + radius circle) — ✅ covered by M6 (`mobile-map-click.png`); click marker visible at the centre of the matches.
- ❌ Polygon close × at NE corner of the polygon — not present in this build. DOM query for any `×`-bearing element after arming the polygon shows only `matches-close`, `preview-close`, `toast-close`, `close-settings`; no polygon-specific close handle. Logged as new finding **M15**.
- ⚠️ Hex cells at low zoom — narrative never zoomed out on mobile; captured in `mobile-sweep-hex-cells.png`. Clicking a cell is a silent no-op (`mobile-sweep-hex-click.png`) — same behaviour as desktop **D18**; on mobile the cells are also small relative to a fingertip, so tap accuracy is even worse. Logged as **M14** for the mobile-specific tap-size amplification.
- ⚠️ Heatmap auto-hide while match active — narrative noted the desktop behaviour (D5) but did not screenshot on mobile. Captured: `mobile-sweep-heatmap-on.png` (heatmap visible before click) and `mobile-sweep-heatmap-vs-match.png` (heatmap replaced by red match polylines, `#heatmap-toggle` confirmed `checked=true, disabled=true`). Same defect as D5 — no new mobile-only finding, but the misleading checkbox state reproduces on touch.
- ⚠️ Esc clears selection — narrative did not cover Esc on mobile (touch keyboards rarely expose it). Captured `mobile-sweep-after-esc.png`. UI clears but `cll=` survives in URL — same as D6. Mobile users in practice cannot reach Esc at all, so the only way to clear a selection is the `#matches-close` × tap target in the awkward top-right thumb zone — logged as **M16**.
- ⚠️ URL reload restores state — narrative did not test on mobile. Loaded `#z=14&ll=…&hm=1&cll=…&mid=18472657487` directly; `mobile-sweep-after-reload.png` shows the matches panel restored (`#matches-panel` display=flex) but the preview panel NOT restored (`#preview-panel` display=none). Same partial-state defect as D15.
- ⚠️ Browser back across navigation — narrative did not test. Navigated to a different hash then `goBack()`; `mobile-sweep-after-back.png` shows the prior `mid=`/`cll=` state restored, matching D15 / boot behaviour.
- Mobile-only: top-spanning right rail with 56 px left gutter — ⚠️ M1 already flags that the gutter is **0 px** in this build (pills overlap toolbar). Right-rail panels (`#matches-panel`) do dock at x=56 (`mobile-matches-toolbar-overlap.png`), so the *rail* respects the 56 px column — but the left pills do not stay outside it, so the promised gutter is effectively absent. See M1.
- Mobile-only: two-page Strava preview carousel — ✅ covered by M7 (`mobile-preview-page1.png`, `mobile-preview-page2.png`).
- Mobile-only: carousel dot indicators — ✅ covered by M7 (6 × 6 px static decorations, non-interactive).

### M14. Hex cells at low zoom — same silent no-op as desktop, worse on touch `confusing`

![](img/ux-audit/mobile-sweep-hex-cells.png)
![](img/ux-audit/mobile-sweep-hex-click.png)

Loading the app at z=8 on mobile produces the same aggregate hex-cell overlay as desktop (D18). Tapping a hex cell produces no response: no popover, no tooltip, no count, no marker. The mobile-specific concern beyond D18: hex cells at z=8 occupy roughly 30–40 px squares on a 390 px viewport, which is at or below the recommended 44 px tap target — so even *if* tapping did something, a fingertip would frequently hit the wrong cell. The hex layer is effectively a decorative chrome strip on mobile.

**Observation:** Same silent-hex defect as D18; on mobile the cells are also borderline-untapped due to size.

### M15. No polygon close-× control at the polygon's NE corner `nit`

![](img/ux-audit/mobile-sweep-polygon-closed.png)

The Pass 2 checklist expected a small × button anchored to the north-east corner of a drawn polygon (to dismiss the filter region without re-arming the draw tool). After arming polygon-draw on mobile and inspecting the DOM, the only `×`-bearing elements are `#matches-close`, `#preview-close`, `#toast-close`, and `#close-settings` — none associated with the polygon. The Leaflet.draw armed-state tooltip provides "Cancel" / "Finish" / "Delete last point" controls but no on-polygon close handle once a polygon has been drawn. To clear a polygon filter the user must re-open the polygon tool's edit mode or refresh — neither of which is discoverable from the polygon outline itself.

**Observation:** No on-polygon × close handle is rendered (DOM-confirmed). Spec describes one; build does not include it.

### M16. Mobile users have no Esc-equivalent for clearing a selection `friction`

![](img/ux-audit/mobile-sweep-after-esc.png)

On desktop Esc clears the match panel and pinned track (D6). On mobile, the mobile-Safari / mobile-Chrome on-screen keyboard does not expose an Escape key when no input is focused, so the keyboard handler is effectively unreachable. The only mobile-accessible dismiss is the `#matches-close` × button at top-right (x=340, y=20, 34 × 42), which sits in the worst thumb-reach zone for a right-handed user holding the phone. There is no tap-outside-to-dismiss, no swipe-down, no drag-handle gesture. So the desktop has two ways to clear a selection (Esc, ×) and mobile has one — and that one is in the hardest-to-reach corner.

**Observation:** Mobile loses the Esc affordance entirely; the only dismiss is a 34-px × in the top-right corner — worst-case ergonomics on a phone.

---

## Pass 2 — Surface inventory

Each entry asks three questions from the icon/label alone before touching it: what does it *claim* to do, what does it *actually* do, and what's the gap. "No gap" entries are useful too — they confirm a control is doing its job. Where a gap exists the related D-/M- finding is cited.

### I1. Zoom + control

![](img/ux-audit/desktop-hover-zoom-in.png)

- **Icon alone claims:** zoom in. Universal "+" — no ambiguity.
- **Actually does:** zooms the map in by one step.
- **Gap:** none. Standard Leaflet default control. Lacks a visible custom tooltip but the action matches the icon (icon-only tooltip issue tracked under D2).

### I2. Zoom − control

![](img/ux-audit/desktop-hover-zoom-in.png)

- **Icon alone claims:** zoom out. Universal "−".
- **Actually does:** zooms the map out one step.
- **Gap:** none. Same Leaflet default; same D2 tooltip caveat.

### I3. Polygon-draw control

![](img/ux-audit/desktop-hover-polygon.png)

- **Icon alone claims:** the first glyph (pentagon outline) reads as "draw a polygon"; the second (rectangle) reads as "draw a rectangle". Both reasonably clear to anyone who has used Leaflet.draw.
- **Actually does:** arms the polygon (or rectangle) draw mode. Leaflet.draw shows a small floating instruction strip near the top-left of the map.
- **Gap:** small. Icon-to-action is fine, but the **armed state** is invisible on the button itself (no active highlight); discoverability of "I am now in drawing mode" is poor. See D9, M11.

### I4. ⟲ reset button

![](img/ux-audit/desktop-hover-reset.png)

- **Icon alone claims:** refresh / reset view. The ⟲ glyph is the universal "reload" / "undo zoom" symbol on every other web map.
- **Actually does:** flies to the bbox of the most recent run; does NOT reset zoom or pan to an "original" view.
- **Gap:** large. Icon implies "reset view", behaviour is "fly to newest". See D1.

### I5. 🗺 display popover trigger

![](img/ux-audit/desktop-hover-display.png)

- **Icon alone claims:** "change map / pick basemap". Map emoji reads as a basemap picker.
- **Actually does:** opens a popover with FOUR controls: base layer picker, base opacity, non-matched track opacity, heatmap toggle. Much broader than "basemap".
- **Gap:** moderate. The 🗺 emoji under-promises — a user who wants to dim track lines won't guess that's behind a map icon. See D3.

### I6. Funnel / filter pane trigger

![](img/ux-audit/desktop-hover-filter.png)

- **Icon alone claims:** filter. The funnel SVG is conventional.
- **Actually does:** opens the filter pane (date presets + range + distance slider + action row).
- **Gap:** none on the icon; the gap is **inside** the pane (label disambiguation between the two action buttons — see D4, I22, I23).

### I7. ⚙ settings drawer trigger

![](img/ux-audit/desktop-boot.png)

- **Icon alone claims:** settings / preferences. Universal gear icon.
- **Actually does:** opens a left-side drawer with library stats, click behaviour, Thunderforest credentials, Strava OAuth, and ZIP import.
- **Gap:** moderate. The icon correctly says "settings" but the drawer is more than settings — it also hosts credentials and bulk import. The mismatch is the drawer contents (D11), not the icon. Position-vs-content also feels off (D10, D16).

### I8. Brand pill

- **Icon alone claims:** N/A. The Pass 2 checklist expected a `run-map` brand pill at bottom-left; nothing renders there besides the ⚙ button.
- **Actually does:** does not exist. DOM-confirmed in D20.
- **Gap:** absent control. Logged as **D20**.

### I9. Road pill

![](img/ux-audit/desktop-trail-only.png)

- **Icon alone claims:** filter to Road activities. The "Road" label is plain text in a pill; reads as either a tab or a toggle.
- **Actually does:** toggles inclusion of Road activities in the aggregate layer (independent boolean — Road and Trail can both be off or both on).
- **Gap:** moderate. Pills look like tabs (single-select) but behave like checkboxes (multi-select). Both-off goes to silent empty map. See D13, D19, M1, M12.

### I10. Trail pill

![](img/ux-audit/desktop-trail-only.png)

- **Icon alone claims:** filter to Trail activities. Same shape/styling as Road.
- **Actually does:** independent boolean toggle for Trail.
- **Gap:** same as I9 (D13). On mobile additionally collides with toolbar (M1).

### I11. Filter chip — date

![](img/ux-audit/desktop-filter-applied.png)

- **Icon alone claims:** "you currently have this date filter applied; click × to remove". Pill format `2025-05-14 → 2026-05-12 ×` is conventional.
- **Actually does:** displays the active date range and provides a × dismiss. Clicking the chip body does nothing — only the × glyph clears the filter.
- **Gap:** small-moderate. Chip body is non-interactive (no "edit filter" affordance), only the × works, and the × is a non-focusable `<span>` (D14, M10).

### I12. Filter chip — distance

- **Icon alone claims:** by inheritance with I11, would show the active distance range and offer × dismiss.
- **Actually does:** when a non-default distance range is set, a second chip renders in the same chip bar with the same `× ` dismiss pattern. Visually identical styling to the date chip. (No fresh capture needed — visible in the same chip-bar element as I11; the spec/code path renders both chips inline once active.)
- **Gap:** same defects as I11 (D14): chip body inert, × is a tiny span. No additional defect specific to distance.

### I13. Filter chip × dismiss

![](img/ux-audit/desktop-filter-chip-removed.png)

- **Icon alone claims:** "remove this filter". Universal × glyph.
- **Actually does:** removes the chip and clears the corresponding filter from state and URL.
- **Gap:** moderate. Action is correct; the implementation is the gap — non-focusable span, ~12 px hit target, no keyboard access. See D14, M10.

### I14. Matches panel × dismiss

![](img/ux-audit/desktop-map-click.png)

- **Icon alone claims:** close the matches panel.
- **Actually does:** closes the matches panel (`#matches-close` confirmed in DOM at top-right of the panel). It also clears the click marker and match polylines.
- **Gap:** small. The × closes more than just the panel — it also clears map decoration — but a user expecting "close panel only" might be mildly surprised. Reaches into adjacent state similar to D6/I4 pattern.

### I15. Strava preview × dismiss

![](img/ux-audit/desktop-match-pinned.png)

- **Icon alone claims:** close the preview panel.
- **Actually does:** dismisses the preview (`#preview-close`) and the orange pinned polyline. `cll`/`mid` URL state behaviour is partial — see D6, D15.
- **Gap:** moderate. Dismiss leaves URL state stale (D6) and reload does not restore the preview (D15).

### I16. Display popover — base layer picker

![](img/ux-audit/desktop-display-baseswitch.png)

- **Icon alone claims:** pick the basemap.
- **Actually does:** switches the underlying tile layer (OSM / OpenTopoMap / Thunderforest variants if credentialed).
- **Gap:** none. Label matches action.

### I17. Display popover — base opacity slider

![](img/ux-audit/desktop-display-opacity.png)

- **Icon alone claims:** adjust basemap opacity.
- **Actually does:** live-updates the basemap layer opacity.
- **Gap:** none. Live update is consistent with other sliders, label is accurate.

### I18. Display popover — non-matched track opacity slider

![](img/ux-audit/desktop-display-open.png)

- **Icon alone claims:** opacity for non-matched (background) tracks.
- **Actually does:** live-updates the aggregate-track opacity.
- **Gap:** none on the slider itself. The label "non-matched" pre-supposes a user understands the matched/aggregate distinction, which a fresh user may not — minor cognitive load only.

### I19. Display popover — heatmap toggle

![](img/ux-audit/desktop-heatmap-vs-match.png)

- **Icon alone claims:** turn the heatmap overlay on/off. Checkbox affordance is honest.
- **Actually does:** on its own, toggles the heat layer. But when a match is active the checkbox is force-disabled with `checked=true`, no inline explanation that heatmap and matches are mutually exclusive.
- **Gap:** large. The checkbox lies about state (says "on" while showing nothing) and becomes silently un-clickable. See D5.

### I20. Filter pane — date picker

![](img/ux-audit/inventory-filter-pane.png)

- **Icon alone claims:** pick a date range. The three preset buttons ("Last month", "Last 6 months", "Last 12 months") and a `Pick a range…` text input are conventional.
- **Actually does:** clicking a preset fills the range; clicking the input opens a date picker. There is a section-local "Clear" button at top-right of the Date heading.
- **Gap:** small. Two clear paths exist (section-local "Clear" next to the heading and the "Clear all" link at the bottom of the pane) — overlapping affordances that aren't obviously different. No D-/M- finding logged for this yet; relates to D14's pattern of underspecified dismiss controls.

### I21. Filter pane — distance slider

![](img/ux-audit/inventory-filter-pane.png)

- **Icon alone claims:** select a distance range. Range slider with `0 km – 84 km` readout and a small histogram chart above showing run-count distribution by distance bucket.
- **Actually does:** dual-thumb slider over the distribution; live-updates the range readout.
- **Gap:** none. The histogram-above-slider is a nice touch that *does* explain the range — one of the better controls in the app.

### I22. Filter pane — `Filter all tracks` button

![](img/ux-audit/desktop-filter-open.png)

- **Icon alone claims:** apply the filter to all tracks. The label is bland — "filter" repeats the word from the pane title.
- **Actually does:** narrows the aggregate map to the filter set (title-attr says "Narrow the aggregate map to this filter set").
- **Gap:** large. Label is indistinguishable from neighbour (I23). See D4, M3.

### I23. Filter pane — `Show matches in view` button

![](img/ux-audit/desktop-filter-open.png)

- **Icon alone claims:** show "matches" within the visible map area. The word "matches" is overloaded — it elsewhere means "tracks near a clicked point".
- **Actually does:** renders filtered tracks within the current viewport as red match polylines. Disabled until something is active; no inline reason given.
- **Gap:** large. Label overlaps semantically with I22 and reuses "matches" with a different meaning than the click→match flow. Disabled-state has no explanation. See D4.

### I24. Filter pane — `Clear all` link

![](img/ux-audit/inventory-filter-pane.png)

- **Icon alone claims:** clear every filter in the pane.
- **Actually does:** resets date + distance to defaults.
- **Gap:** small. Action matches label; gap is the overlap with the section-local "Clear" in I20. Two clear paths, no clear (sic) rule about which to use.

### I25. Settings drawer — sections

#### I25a. Your library (stats)

![](img/ux-audit/inventory-settings-top.png)

- **Icon alone claims:** N/A — heading-only section.
- **Actually does:** shows total run count, date range, and a per-year bar chart with Road/Trail colour legend.
- **Gap:** small. Useful info but feels like dashboard content stuck inside a "Settings" drawer; could live elsewhere. See D11.

#### I25b. Click behaviour — Search radius slider + Apply

![](img/ux-audit/inventory-settings-top.png)

- **Icon alone claims:** set the search radius for map-click matching, then press Apply.
- **Actually does:** slider at 0 labelled "auto", with an Apply button. Two adjacent checkboxes below ("Lock tap to nearest track", "Zoom to fit matched tracks") update live.
- **Gap:** large. Slider is the only control in the app needing an explicit Apply (D12); units, range, and effect of "auto" are unlabelled. Inconsistent with the live-update sliders in the Display popover.

#### I25c. Click behaviour — Lock tap to nearest track

![](img/ux-audit/inventory-settings-top.png)

- **Icon alone claims:** when tapping the map, snap selection to the closest track.
- **Actually does:** as advertised. Toggle is live (no Apply needed).
- **Gap:** none on the control. Inconsistency with the sibling Search radius slider (I25b) is the only friction.

#### I25d. Click behaviour — Zoom to fit matched tracks

![](img/ux-audit/inventory-settings-top.png)

- **Icon alone claims:** when matches appear, fit the map to them.
- **Actually does:** as advertised. Toggle is live.
- **Gap:** none.

#### I25e. Thunderforest — API key, Save, Clear

![](img/ux-audit/inventory-settings-top.png)

- **Icon alone claims:** add a Thunderforest API key to unlock more basemaps. Sign-up link inline.
- **Actually does:** Save persists the key, Clear removes it. Successful save adds the Outdoors / Landscape / OpenCycleMap options to the I16 picker.
- **Gap:** moderate. The fact that this control LIVES in Settings rather than near the I16 base-layer picker creates a cross-drawer dependency: the user must open Settings to *enable* a Display option, then close Settings and open Display to *use* it. See D11.

#### I25f. Strava API — Test connection + Credentials group

![](img/ux-audit/inventory-settings-bottom.png)

- **Icon alone claims:** configure Strava OAuth credentials, test them.
- **Actually does:** Test connection button hits a backend health endpoint; Credentials fieldset holds the client-id / client-secret inputs.
- **Gap:** moderate. Same drawer-purpose mismatch as D11 — destructive/auth controls living alongside cosmetic prefs.

#### I25g. Strava API — Sync range + Sync now

![](img/ux-audit/inventory-settings-bottom.png)

- **Icon alone claims:** choose how far back to sync, then sync.
- **Actually does:** combobox + button to trigger ingestion.
- **Gap:** moderate. "Sync now" is a long-running, side-effectful action sharing the same drawer as a checkbox like I25d. Risk of mis-tap on mobile (M5).

#### I25h. Strava API — Forget tokens

- **Icon alone claims:** revoke / drop stored Strava tokens. Mentioned in the existing D11 capture; visible in `desktop-settings-strava.png`.
- **Actually does:** removes the OAuth refresh/access tokens from storage.
- **Gap:** large in context. A destructive button living next to cosmetic toggles (D11), with no confirmation visible.

#### I25i. Import Strava export ZIP

![](img/ux-audit/inventory-settings-bottom.png)

- **Icon alone claims:** bulk-import a Strava archive ZIP.
- **Actually does:** opens a file picker and ingests an archive into DuckDB.
- **Gap:** moderate. Heavyweight, one-time admin action behind a "Settings" gear (D11).

### Systemic patterns

- **Icon language is mixed and inconsistent** — emoji (🗺, ⚙), Unicode glyphs (⟲, ×), Leaflet defaults (+, −), and SVG funnels coexist with no unifying style. Draws on I4, I5, I7, I13, I14.
- **Dismiss / clear paths are duplicated in some places and absent in others.** The filter pane has both a section-local "Clear" and a global "Clear all" (I20, I24); the polygon overlay has no on-shape close at all (M15); chips have a × glyph that is the only path (I11, I13). No consistent rule.
- **No consistent rule for "which container hosts which control."** Popover, drawer, and inline panel are used interchangeably: I16-I19 are in a popover, I20-I24 are in a pane, I25a-I25i are in a drawer. Cosmetic prefs and destructive admin actions share the drawer (I25b vs I25h), while a credential entry (I25e) gates a sibling control in a completely different container (I16).
- **Several controls quietly couple to other state without communicating it.** Heatmap auto-disables when a match is active but says it's still on (I19/D5); Display popover anchors over the Filter button (M4); pills both-off silently empties the map (I9/I10/D19). The UI does the right thing for the *system* but lies to the *user*.
- **Labels conflate "filter" and "match"** across I22, I23, I14, and the click→match flow. "Show matches" means one thing in the filter pane and another after a map click, with no glossary or wayfinding.

---

## Pass 3 — Proposed fixes

_To be filled in Task 6._
