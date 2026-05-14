# run-map UX audit — design

A fresh-eyes UX audit of the run-map app. Findings, with proposed fixes (mockups, icon sets, layout changes) where they address a concrete UX issue.

## Goal

Produce an annotated walkthrough that surfaces friction, ambiguity, redundancy, and missing feedback across the full interaction surface (chrome + flows + modes) of run-map, from the perspective of a user who has never seen the app before. Where a finding warrants it, the audit proposes a fix — an icon swap, a layout sketch, a copy change, a small mockup. The fresh-eyes lens applies to *finding* the issues, not to proposing the fixes.

## Scope

In scope:
- All visible chrome: Leaflet toolbar, left rail, top-centre chip bar, bottom-left brand/⚙, right-rail panels (matches, Strava preview).
- All flows: click → match, polygon/rectangle draw, filter pane, type pills, display popover, settings drawer, ⟲ reset, Esc, URL/back-button.
- All modes and their interactions: idle, match-active, filter-active, both-active, heatmap-on (and its auto-hide when a match is active), both pills off.
- Desktop (1440×900) and mobile (390×844, below the 700 px breakpoint).

Out of scope:
- Heuristic frameworks (Nielsen etc.) — fresh eyes, not a checklist audit.
- Backend / API ergonomics.
- Performance.
- Implementing the fixes. Proposals only; actual code changes follow in a separate cycle.

## Perspective

Fresh user — someone who has never seen the app, does not know what the icons mean, has not read `SPEC.md`. The auditor must resist consulting `SPEC.md` or `app.js` during Pass 1; doing so collapses the lens and the audit loses its point.

## Method

### Pass 1 — Narrative poke-around (per viewport)

For each of desktop (1440×900) and mobile (390×844):

1. Navigate to the app in Playwright. Do not pre-load any context about controls or behaviour.
2. React to what is visible. For each control or affordance, ask "what does this claim to do?" before touching it, then touch it and note the gap (if any) between expectation and behaviour.
3. Walk natural exploratory paths: hover/click each toolbar button, click the map to trigger a match, open each popover, draw a polygon, toggle the Road/Trail pills, open the settings drawer, reload the page to observe URL-state restoration, press Esc.
4. Screenshot whenever something is unclear, ambiguous, redundant, missing feedback, surprising, or visually inconsistent. Screenshots are the evidence; commentary is the finding.

### Coverage-checklist sweep

After each viewport's narrative pass, verify every surface listed below was touched. Anything skipped gets a quick separate capture *and* a note on why the narrative missed it (a surface a fresh user never wanders into is itself a discoverability finding).

Surfaces to confirm:
- Leaflet toolbar: zoom controls, polygon-draw, ⟲ reset, 🗺 display popover, ⚙ settings (bottom-left on desktop), funnel (filter pane).
- Left rail: Road / Trail pills, including the both-off "(i) All tracks hidden" state.
- Top-centre: filter chip bar (date and distance chips with × dismiss).
- Right rail: matches panel, Strava preview panel; both with × dismiss.
- Mobile-specific: top-spanning rail with 56 px left gutter, two-page scroll-snap carousel with dot indicators in the Strava preview.
- Map interactions: click → match (with click marker + radius circle), polygon close button at NE corner, hex cells at low zoom, heatmap auto-hide while a match is active.
- Global: Esc behaviour, URL reload restoring state, browser back across pushState navigation.

### Pass 2 — Surface inventory (follow-up)

After both narrative passes are complete. For each control identified in the coverage checklist, in isolation:
- Screenshot it.
- One-liner: what its icon/label alone *claims* it does.
- One-liner: what it *actually* does.
- One-liner: the gap, if any.

This catches things a narrative naturally rationalizes past once the auditor has built a mental model of the app.

### Pass 3 — Proposed fixes

After findings are written up, revisit each finding (across both passes) and decide whether it warrants a concrete proposal. Only at this stage may the auditor read `SPEC.md`, `app.js`, and `style.css` — the fresh-eyes lens has already done its work.

For each finding that warrants a proposal:
- Sketch the fix. Options include: an icon swap (name the icon set and the specific glyph, e.g. Lucide `sliders-horizontal`), a copy change, a layout adjustment (described in prose or ASCII), a small HTML/CSS mockup committed under `docs/img/ux-audit/mockups/`, or a grouping change (e.g. "fold ⟲ into a navigation cluster with zoom").
- Keep proposals scoped to the issue. No opportunistic refactors. A finding about one button does not justify redesigning the whole toolbar — unless the finding *is* "the whole toolbar is incoherent", in which case a toolbar-level proposal is fair game.
- Not every finding needs a proposal. Some findings are best left as observations for the user to decide on.

## Tooling

- The app is already running locally with real user data. Connect to it as-is. **Do not** run `docker compose up`, `down`, `restart`, `build`, any ingest endpoint, or any reset / cache-invalidation operation during the audit. The live data is the fixture.
- Playwright via `mcp__plugin_playwright_playwright__*` for navigation, viewport resize, hover, click, screenshot, and console-message capture.
- Capture browser console messages alongside screenshots; unexpected errors or warnings are findings.

## Output

Single file: `docs/UX-AUDIT.md`.

Structure:
- `## Pass 1 — Desktop narrative`
- `## Pass 1 — Mobile narrative`
- `## Pass 2 — Surface inventory`
- `## Pass 3 — Proposed fixes` (cross-references findings from Pass 1 and 2 by anchor)

Each finding contains:
- Reference to a screenshot under `docs/img/ux-audit/` (new subdirectory).
- Inline prose with numbered callouts pointing into the screenshot.
- Severity tag, one of: `nit`, `friction`, `confusing`, `broken`.
- A short observation of what is wrong.

Each proposed fix (Pass 3) contains:
- Anchor back to the finding(s) it addresses.
- The proposal itself: icon name + set, copy text, ASCII layout, or path to a mockup image under `docs/img/ux-audit/mockups/`.
- One sentence on why this addresses the finding.

Screenshots: place under `docs/img/ux-audit/` with descriptive filenames (e.g. `desktop-boot.png`, `mobile-display-popover.png`).

## Explicit non-goals

- No comparison to other map apps or external products.
- No reading of `app.js`, `style.css`, or `SPEC.md` during Pass 1 or Pass 2 — those are the fresh-eyes passes.
- No implementing of the proposed fixes. The audit produces proposals only; code changes follow in a separate cycle.
- No changes to application code, data, or running services during the audit (this includes Pass 3 — mockups live under `docs/img/ux-audit/mockups/`, not in the live frontend).

## Success criteria

The audit is complete when:
- `docs/UX-AUDIT.md` exists with all four sections populated (Pass 1 desktop, Pass 1 mobile, Pass 2 inventory, Pass 3 proposals).
- Every surface in the coverage checklist is either represented in the narrative or has its own inventory entry.
- Each finding is anchored to at least one screenshot and tagged with severity.
- Each Pass 3 proposal anchors back to the finding it addresses.
- The live app and its data are untouched.
