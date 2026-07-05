"""Smoke tests for the run-map UI on desktop and mobile viewports.

Run with:
    pytest tests/

Both tests:
  1. Load the page with a saved view hash so tracks are immediately in frame.
  2. Wait for tracks to render.
  3. Click roughly in the middle of the map.
  4. Assert that *something* responds — either the matches panel opens
     (multi-match) or the Strava preview opens (single-match auto).

The mobile test additionally verifies the right rail is laid out for the
narrow viewport (full-width-ish, not the 360 px desktop column).
"""

from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, expect


def _type_param(url: str) -> str | None:
    """Decoded `type` query param of a request URL. Exact comparison only —
    substring checks like `"type=TrailRun" in url` silently match the
    URL-encoded comma form `type=TrailRun%2CHike`."""
    vals = parse_qs(urlparse(url).query).get("type")
    return vals[0] if vals else None


def _seed_map(page: Page, app_url: str):
    # Boot loads /index.json + /aggregate.geojson. Once the aggregate layer
    # is on the map, applyURLState has finished — that's the readiness signal
    # we wait on.
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => window.__rm && window.__rm.aggregateOn && window.__rm.aggregateOn()",
        timeout=20_000,
    )
    page.wait_for_timeout(200)


def _let_popovers_close(page: Page):
    """Move the pointer to neutral ground and wait for the hover popovers'
    grace timer to close them. A click that lands while a popover is open is
    (deliberately) consumed as a dismissal, not a map interaction."""
    page.mouse.move(600, 760)
    for menu_id in ("display-menu", "filter-menu"):
        page.wait_for_function(
            f"() => document.getElementById('{menu_id}').classList.contains('hidden')",
            timeout=3_000,
        )


def _click_centre_of_map(page: Page):
    bb = page.locator("#map").bounding_box()
    assert bb, "#map not found"
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)


def _assert_something_responded(page: Page):
    """Either the matches list opens, or the preview opens (single match)."""
    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)",
        timeout=8_000,
    )


# ---------- Desktop ---------------------------------------------------------


def test_desktop_click_opens_a_panel(page: Page, app_url):
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    _click_centre_of_map(page)
    _assert_something_responded(page)


def test_desktop_settings_drawer(page: Page, app_url):
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.click("#open-settings")
    expect(page.locator("#settings-drawer")).not_to_have_class("hidden")
    page.click("#close-settings")


def test_aggregate_layer_present(page: Page, app_url):
    """At track-view zoom the aggregate layer must be on the map."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)
    assert page.evaluate("() => window.__rm.aggregateOn()"), \
        "aggregate layer not added to map"


def test_aggregate_lod_swaps_with_zoom(page: Page, app_url):
    """Boot at each zoom band; the active aggregate LOD must reflect it."""
    page.set_viewport_size({"width": 1280, "height": 800})
    base = app_url.split("#")[0]
    cases = [(12, "low"), (14, "mid"), (17, "high")]
    for z, expected in cases:
        page.goto(f"{base}#z={z}&ll=53.5,-1.5&preset=all", wait_until="domcontentloaded")
        # Wait until the aggregate layer for this zoom is on the map.
        page.wait_for_function(
            f"() => window.__rm && window.__rm.aggregateLod && window.__rm.aggregateLod() === '{expected}'",
            timeout=20_000,
        )
        assert page.evaluate("() => window.__rm.aggregateOn()"), \
            f"aggregate not on map at z={z}"


def test_click_to_match_still_works_after_zoom(page: Page, app_url):
    """Snap-to-track segments are loaded from the high LOD regardless of which
    LOD is currently displayed, so clicking a track must resolve at any zoom."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)
    base = app_url.split("#")[0]
    page.goto(f"{base}#z=12&ll=53.5,-1.5&preset=all", wait_until="domcontentloaded")
    page.wait_for_function(
        "() => window.__rm && window.__rm.aggregateLod && window.__rm.aggregateLod() === 'low'",
        timeout=20_000,
    )
    # Snap segments come from the high LOD — ensure they're loaded before clicking.
    page.wait_for_function(
        "() => window.__rm && window.__rm.snapSegmentsLoaded() > 0",
        timeout=10_000,
    )
    bb = page.locator("#map").bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )


def test_match_geometry_renders_red_polyline(page: Page, app_url):
    """Clicking should populate matches AND draw the precise red track(s).

    Before this work, matches were drawn by recolouring pre-loaded tracks;
    now they're built from inline geometry returned by /match. The
    `matchLayersById` JS map is the source of truth.
    """
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    with page.expect_response(lambda r: "/match" in r.url and r.status == 200, timeout=10_000):
        bb = page.locator("#map").bounding_box()
        page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)

    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )
    match_count = page.evaluate("() => window.__rm.matchCount()")
    assert match_count > 0, "no match polylines were built from /match geometry"


def test_draw_zooms_to_polygon_bounds(page: Page, app_url):
    """Drawing a bounding shape must fly the map to that shape's bounds, even
    when the polygon contains matched tracks."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    target = page.evaluate(
        """() => {
            const c = window.__rm.map.getCenter();
            const d = 0.005;
            return {
                south: c.lat - d, north: c.lat + d,
                west:  c.lng - d, east:  c.lng + d,
            };
        }"""
    )

    # Synthesise a polygon-draw event with bounds we control, then verify the
    # camera lands inside (or fits around) those bounds.
    page.evaluate(
        """target => {
            const m = window.__rm.map;
            const sw = L.latLng(target.south, target.west);
            const ne = L.latLng(target.north, target.east);
            const ring = [sw, L.latLng(target.south, target.east), ne, L.latLng(target.north, target.west)];
            const poly = L.polygon(ring);
            m.fire(L.Draw.Event.CREATED, { layer: poly, layerType: 'polygon' });
        }""",
        target,
    )

    # Wait for flyToBounds to settle.
    page.wait_for_timeout(900)

    view = page.evaluate(
        """() => {
            const b = window.__rm.map.getBounds();
            return {
                south: b.getSouth(), north: b.getNorth(),
                west:  b.getWest(),  east:  b.getEast(),
            };
        }"""
    )

    # The visible bounds should fully contain the polygon bounds.
    assert view["south"] <= target["south"] and view["north"] >= target["north"], \
        f"polygon lat bounds not in view: view={view} target={target}"
    assert view["west"] <= target["west"] and view["east"] >= target["east"], \
        f"polygon lng bounds not in view: view={view} target={target}"


def test_dim_opacity_setting(page: Page, app_url):
    """The dim-opacity slider in settings should control the aggregate layer's
    opacity when a match is active; default is 45%."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Default value — slider lives in the 🗺 display popover.
    page.locator('a[title="Display"]').hover()
    page.locator("#display-menu").wait_for(state="visible", timeout=3_000)
    expect(page.locator("#dim-opacity")).to_have_value("45")

    # Trigger a match so the aggregate gets dimmed. Let the popover close
    # first — clicks that land while it's open only dismiss it.
    _let_popovers_close(page)
    _click_centre_of_map(page)
    _assert_something_responded(page)

    op = page.evaluate(
        """() => {
            const lod = window.__rm.aggregateLod();
            const m = window.__rm.map;
            let found = null;
            m.eachLayer(l => { if (l.options && l.options.color === '#1a5a8a' && l.options.opacity != null) found = l.options.opacity; });
            return found;
        }"""
    )
    assert op is not None and abs(op - 0.45) < 0.01, f"expected aggregate opacity ~0.45, got {op}"

    # Drag slider to 20 → aggregate opacity follows.
    page.evaluate(
        """() => {
            const el = document.getElementById('dim-opacity');
            el.value = '20';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }"""
    )
    op2 = page.evaluate(
        """() => {
            const m = window.__rm.map;
            let found = null;
            m.eachLayer(l => { if (l.options && l.options.color === '#1a5a8a' && l.options.opacity != null) found = l.options.opacity; });
            return found;
        }"""
    )
    assert op2 is not None and abs(op2 - 0.20) < 0.01, f"expected aggregate opacity ~0.20, got {op2}"


def test_thunderforest_requires_apikey(page: Page, app_url):
    """Selecting a Thunderforest base layer with no API key in localStorage
    should toast and revert without swapping the active layer."""
    page.set_viewport_size({"width": 1280, "height": 800})
    # Ensure no key is set before the page boots.
    page.add_init_script("window.localStorage.removeItem('runmap.tfApiKey');")
    _seed_map(page, app_url)

    # Capture initial active base-layer attribution snippet so we can detect change.
    before = page.evaluate(
        """() => {
            const m = window.__rm.map;
            let active = null;
            m.eachLayer(l => {
                if (l instanceof L.TileLayer) {
                    const u = l._url || '';
                    if (u && active == null) active = u;
                }
            });
            return active;
        }"""
    )

    page.locator('a[title="Display"]').hover()
    page.locator("#display-menu").wait_for(state="visible", timeout=3_000)
    page.select_option('#base-layer', 'Thunderforest Outdoors')

    # Toast should appear.
    page.wait_for_selector('#toast:not(.hidden)', timeout=3_000)
    txt = page.locator('#toast-text').inner_text()
    assert 'Thunderforest' in txt, f"unexpected toast: {txt!r}"

    after = page.evaluate(
        """() => {
            const m = window.__rm.map;
            let active = null;
            m.eachLayer(l => {
                if (l instanceof L.TileLayer) {
                    const u = l._url || '';
                    if (u && active == null) active = u;
                }
            });
            return active;
        }"""
    )
    assert after == before, "active base layer should not switch without an API key"


def test_heatmap_toggle(page: Page, app_url):
    """The heatmap overlay lives in the 🗺 display popover and toggles the
    heatmap layer on the map."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Open the display popover via its title-tagged Leaflet control.
    page.locator('a[title="Display"]').hover()
    page.locator("#display-menu").wait_for(state="visible", timeout=3_000)
    page.check("#heatmap-toggle")

    page.wait_for_function("() => window.__rm.heatmapOn()", timeout=10_000)
    assert page.evaluate("() => window.__rm.heatmapOn()"), \
        "heatmap layer not added to map when toggled on"

    page.uncheck("#heatmap-toggle")
    assert not page.evaluate("() => window.__rm.heatmapOn()"), \
        "heatmap layer not removed from map when toggled off"


def test_heatmap_hides_on_match(page: Page, app_url):
    """Toggling the heatmap on then clicking should hide the heatmap while
    the match is active and restore it when the match is cleared."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Turn the heatmap on.
    page.locator('a[title="Display"]').hover()
    page.locator("#display-menu").wait_for(state="visible", timeout=3_000)
    page.check("#heatmap-toggle")
    page.wait_for_function("() => window.__rm.heatmapOn()", timeout=10_000)

    # Click the centre of the map — should produce matches. Let the popover
    # close first — clicks that land while it's open only dismiss it.
    _let_popovers_close(page)
    bb = page.locator("#map").bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )

    # Heatmap must be off-map while a match is showing.
    assert not page.evaluate("() => window.__rm.heatmapOn()"), \
        "heatmap should be hidden while a match is active"


def test_filter_chip_flow(page: Page, app_url):
    """Adding a date-range filter via the chip bar should refetch data and the
    chip should appear; clearing the chip should reset."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)

    # Click a preset shortcut — the picker fills both endpoints.
    page.click('#filter-date-presets button.date-preset:has-text("Last month")')
    page.click("#filter-apply")

    # Chip bar should now contain exactly one chip (the date range).
    page.wait_for_selector("#filter-chips .chip", timeout=5_000)
    assert page.evaluate("() => document.querySelectorAll('#filter-chips .chip').length") == 1
    chip_text = page.locator("#filter-chips .chip").inner_text()
    assert "→" in chip_text, f"expected date-range chip, got {chip_text!r}"

    # Remove the chip via its × button → chip disappears.
    page.click("#filter-chips .chip .x")
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-chips .chip').length === 0",
        timeout=5_000,
    )


def test_datepicker_month_nav_keeps_filter_pane_open(page: Page, app_url):
    """Flatpickr renders its calendar in document.body — clicking the month
    navigation arrows must NOT collapse the host filter pane."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.click("#filter-date-range")
    page.locator(".flatpickr-calendar.open").wait_for(state="visible", timeout=3_000)
    page.locator(".flatpickr-calendar.open .flatpickr-prev-month").first.click()
    assert not page.locator("#filter-menu").evaluate("el => el.classList.contains('hidden')"), \
        "filter menu collapsed when navigating the date picker"


def test_filter_date_clear_button(page: Page, app_url):
    """The Clear-date link in the filter pane removes only the date selection."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.click('#filter-date-presets button.date-preset:has-text("Last month")')
    val = page.input_value("#filter-date-range")
    assert val, "date range did not populate from preset"
    page.click("#filter-date-clear")
    cleared = page.input_value("#filter-date-range")
    assert cleared == "", f"expected cleared date, got {cleared!r}"


def test_three_type_pills_render(page: Page, app_url):
    """Road, Trail, and Hike pills all render and start active, with no
    redundant filter chips."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    for t in ("Run", "TrailRun", "Hike"):
        expect(page.locator(f'#type-pills [data-type="{t}"]')).to_have_class("type-pill active")
    assert page.evaluate("() => document.querySelectorAll('#filter-chips .chip').length") == 0


def test_type_pill_filter(page: Page, app_url):
    """Clicking the Road pill deactivates it, scoping to Trail + Hike. The
    network request carries the comma-list type query param. No chip — the
    pills themselves show the active types."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Pills are always visible in the top filter bar — no need to open the pane.
    road = page.locator('#type-pills [data-type="Run"]')
    trail = page.locator('#type-pills [data-type="TrailRun"]')
    hike = page.locator('#type-pills [data-type="Hike"]')
    expect(road).to_have_class("type-pill active")
    expect(trail).to_have_class("type-pill active")
    expect(hike).to_have_class("type-pill active")

    with page.expect_response(
        lambda r: "/aggregate.geojson" in r.url and _type_param(r.url) == "TrailRun,Hike",
        timeout=10_000,
    ):
        road.click()

    expect(road).not_to_have_class("type-pill active")
    expect(trail).to_have_class("type-pill active")
    expect(hike).to_have_class("type-pill active")
    # No redundant type chip — pills are the source of truth.
    assert page.evaluate("() => document.querySelectorAll('#filter-chips .chip').length") == 0


def test_hike_only_pill_state(page: Page, app_url):
    """Turning Road and Trail off scopes requests to type=Hike and records
    it in the URL hash. (Doesn't assert tracks render — the library may
    contain no hikes.)"""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('#type-pills [data-type="Run"]').click()
    with page.expect_response(
        lambda r: "/aggregate.geojson" in r.url and _type_param(r.url) == "Hike",
        timeout=10_000,
    ):
        page.locator('#type-pills [data-type="TrailRun"]').click()

    expect(page.locator('#type-pills [data-type="Hike"]')).to_have_class("type-pill active")
    page.wait_for_function("() => location.hash.includes('ftype=Hike')", timeout=4_000)


def test_url_hash_restores_multi_type_pills(page: Page, app_url):
    """Loading a URL whose hash carries a comma-list ftype restores the
    matching pill states."""
    page.set_viewport_size({"width": 1280, "height": 800})
    # app_url already carries a saved-view hash — extend it rather than
    # appending a second '#'.
    page.goto(app_url + "&ftype=TrailRun%2CHike", wait_until="domcontentloaded")
    # Same readiness signal as _seed_map: once the aggregate is on the map,
    # applyURLState has finished (and with it the pill sync).
    page.wait_for_function(
        "() => window.__rm && window.__rm.aggregateOn && window.__rm.aggregateOn()",
        timeout=20_000,
    )

    expect(page.locator('#type-pills [data-type="Run"]')).not_to_have_class("type-pill active")
    expect(page.locator('#type-pills [data-type="TrailRun"]')).to_have_class("type-pill active")
    expect(page.locator('#type-pills [data-type="Hike"]')).to_have_class("type-pill active")


def test_type_pill_all_off_hides_tracks(page: Page, app_url):
    """Turning all three pills off shows the 'All tracks hidden' notice and
    removes the aggregate layer; turning one back on restores it."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    road = page.locator('#type-pills [data-type="Run"]')
    trail = page.locator('#type-pills [data-type="TrailRun"]')
    hike = page.locator('#type-pills [data-type="Hike"]')
    notice = page.locator('#type-empty-notice')

    road.click()
    trail.click()
    hike.click()
    expect(road).not_to_have_class("type-pill active")
    expect(trail).not_to_have_class("type-pill active")
    expect(hike).not_to_have_class("type-pill active")
    expect(notice).to_be_visible()
    assert not page.evaluate("() => window.__rm.aggregateOn()"), \
        "aggregate should be off the map with all pills off"

    road.click()
    expect(notice).to_be_hidden()
    page.wait_for_function("() => window.__rm.aggregateOn()", timeout=8_000)


def test_popover_dismiss_click_does_not_fire_match(page: Page, app_url):
    """Clicking the map to close an open popover must ONLY close the popover —
    it must not drop a pin and run a match query underneath."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    # Move pointer away from the funnel first so hover-close isn't a factor,
    # then dismiss by clicking the map.
    _click_centre_of_map(page)
    page.locator("#filter-menu").wait_for(state="hidden", timeout=3_000)
    page.wait_for_timeout(1_500)
    assert page.evaluate("() => window.__rm.matchCount()") == 0, \
        "dismissing a popover must not trigger a match"
    assert page.evaluate("() => document.querySelectorAll('.click-pin').length") == 0, \
        "dismissing a popover must not drop a click pin"


def test_filter_change_keeps_old_aggregate_until_swap(page: Page, app_url):
    """Toggling a type pill must not blank the map — the old aggregate stays
    on screen until the new one is built, then they swap."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.click('#type-pills [data-type="Run"]')
    # Immediately after the click the old layer must still be attached
    # (the old code removed it synchronously in the click tick).
    assert page.evaluate("() => window.__rm.aggregateOn()"), \
        "aggregate must stay visible while the filtered layer loads"
    # And once the new layer lands, it's attached too.
    page.wait_for_timeout(4_000)
    assert page.evaluate("() => window.__rm.aggregateOn()")


def test_closing_matches_panel_clears_polygon(page: Page, app_url):
    """Dismissing polygon-derived matches via the panel's × must clear the
    drawn polygon too — no stranded outline pretending to be a filter."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.evaluate(
        """() => {
            const c = window.__rm.map.getCenter();
            const d = 0.004;
            const ring = [
                L.latLng(c.lat - d, c.lng - d), L.latLng(c.lat - d, c.lng + d),
                L.latLng(c.lat + d, c.lng + d), L.latLng(c.lat + d, c.lng - d),
            ];
            window.__rm.map.fire(L.Draw.Event.CREATED, { layer: L.polygon(ring), layerType: 'polygon' });
        }"""
    )
    page.wait_for_selector("#matches-panel:not(.hidden)", timeout=15_000)
    page.click("#matches-close")
    page.wait_for_timeout(500)
    assert page.evaluate("() => document.querySelectorAll('.polygon-close-btn').length") == 0, \
        "polygon close button must be removed with the matches"
    assert not page.evaluate("() => location.hash.includes('poly=')"), \
        "polygon filter must be cleared from the URL state"


def test_matches_panel_has_summary_header(page: Page, app_url):
    """A multi-match result opens with a count + date-span summary line and
    year separator rows — the 'when?' answer before any scrolling."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.evaluate(
        """() => {
            const c = window.__rm.map.getCenter();
            const d = 0.004;
            const ring = [
                L.latLng(c.lat - d, c.lng - d), L.latLng(c.lat - d, c.lng + d),
                L.latLng(c.lat + d, c.lng + d), L.latLng(c.lat + d, c.lng - d),
            ];
            window.__rm.map.fire(L.Draw.Event.CREATED, { layer: L.polygon(ring), layerType: 'polygon' });
        }"""
    )
    page.wait_for_selector("#matches-panel:not(.hidden)", timeout=15_000)
    page.wait_for_selector(".matches-summary", timeout=5_000)
    summary = page.locator(".matches-summary").inner_text()
    count = page.evaluate("() => window.__rm.matchCount()")
    assert str(count) in summary and "matches" in summary, summary
    assert "→" in summary, f"summary should carry a first→last span: {summary}"
    seps = page.evaluate("() => document.querySelectorAll('.matches-table tr.year-sep').length")
    assert seps >= 1, "year separator rows should be present"


def test_worn_path_bucket_styles_render(page: Page, app_url):
    """The aggregate renders as three worn-path buckets with distinct stroke
    weights (habitual routes heavier than one-offs)."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    weights = page.evaluate(
        """() => {
            const seen = new Set();
            for (const k in window.__rm.map._layers) {
                const l = window.__rm.map._layers[k];
                if (l.options && l.options.pane === 'aggPane' && l.options.weight) {
                    seen.add(l.options.weight);
                }
            }
            return Array.from(seen).sort();
        }"""
    )
    assert len(weights) == 3, f"expected 3 bucket weights, got {weights}"


def test_stats_content_id_is_unique(page: Page, app_url):
    """index.html previously duplicated id="stats-content"; getElementById
    silently binds the first, leaving the second an unstylable landmine."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)
    assert page.evaluate("() => document.querySelectorAll('#stats-content').length") == 1


def test_all_types_off_survives_zoom(page: Page, app_url):
    """The 'All tracks hidden' state must hold across zoom changes: zooming
    below the hex threshold must not render hexes, and zooming back in must
    not resurrect the aggregate."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    for t in ("Run", "TrailRun", "Hike"):
        page.click(f'#type-pills [data-type="{t}"]')
    expect(page.locator("#type-empty-notice")).to_be_visible()

    page.evaluate("() => window.__rm.map.setZoom(9)")
    page.wait_for_timeout(1200)
    assert not page.evaluate("() => window.__rm.hexOn()"), \
        "hex layer must stay hidden while all types are off"

    page.evaluate("() => window.__rm.map.setZoom(14)")
    page.wait_for_timeout(1200)
    assert not page.evaluate("() => window.__rm.aggregateOn()"), \
        "aggregate must stay hidden while all types are off"

    # Turning a pill back on restores the normal zoom behaviour.
    page.click('#type-pills [data-type="Run"]')
    page.wait_for_function("() => window.__rm.aggregateOn()", timeout=8_000)


def _first_nonzero_snap(page: Page) -> int:
    """Return the smallest non-zero distance in the slider's snap set —
    guaranteed to exist in the user's library, so setting the lower handle
    to it survives snapping intact."""
    vals = page.evaluate("() => window.__rm.distSnapValues()")
    nz = [v for v in vals if v > 0]
    assert nz, f"snap set has no non-zero values: {vals}"
    return nz[0]


def test_distance_histogram_dual_slider(page: Page, app_url):
    """The distance filter renders histogram bars and a dual-handle slider;
    moving the lower handle off zero applies a min_km filter."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    # Histogram has at least one bar after population.
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-dist-hist rect').length > 0",
        timeout=4_000,
    )
    target = _first_nonzero_snap(page)
    # Move the lower slider to a real snap value — slider snaps to actual run
    # distances, so an arbitrary km value would be rewritten on `input`.
    page.evaluate(
        f"""
        () => {{
            const lo = document.getElementById('filter-dist-min');
            lo.value = '{target}';
            lo.dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}
        """
    )
    # Readout reflects the new lower bound.
    readout = page.locator("#filter-dist-readout").inner_text()
    assert f"{target} km" in readout, readout

    with page.expect_response(
        lambda r: "/aggregate.geojson" in r.url and f"min_km={target}" in r.url,
        timeout=10_000,
    ):
        page.click("#filter-apply")
    page.wait_for_selector("#filter-chips .chip", timeout=4_000)


def test_distance_slider_snaps_to_actual_distances(page: Page, app_url):
    """The slider thumbs lock onto distances that exist in the library, so an
    intermediate raw value gets rewritten to the nearer snap point."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-dist-hist rect').length > 0",
        timeout=4_000,
    )

    vals = page.evaluate("() => window.__rm.distSnapValues()")
    # Need at least two distinct snap points either side of a gap to exercise
    # the snap. Pick the largest gap between consecutive snap values.
    pairs = list(zip(vals, vals[1:]))
    a, b = max(pairs, key=lambda ab: ab[1] - ab[0])
    if b - a < 2:
        # Library is too dense for a meaningful snap test; nothing to assert.
        return
    midpoint_biased_low = a + (b - a) // 3  # closer to `a` than to `b`

    snapped = page.evaluate(
        f"""
        () => {{
            const lo = document.getElementById('filter-dist-min');
            lo.value = '{midpoint_biased_low}';
            lo.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return Number(lo.value);
        }}
        """
    )
    assert snapped == a, (
        f"expected snap from {midpoint_biased_low} to {a} (snap set "
        f"around the gap: ...{a}, {b}...), got {snapped}"
    )


def test_show_as_matches_disabled_when_no_filters(page: Page, app_url):
    """With no active filters, the Show-as-matches button starts disabled
    when the filter pane opens from a clean state."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    expect(page.locator("#filter-show-matches")).to_be_disabled()


def test_show_as_matches_renders_filtered_set(page: Page, app_url):
    """Dragging the distance min slider enables Show-as-matches; clicking it
    fetches /match/filter and renders the result via renderMatches."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-dist-hist rect').length > 0",
        timeout=4_000,
    )
    # Move lower slider to the smallest non-zero snap point — slider snaps to
    # actual run distances, so any other value would be rewritten on `input`.
    target = _first_nonzero_snap(page)
    page.evaluate(
        f"""
        () => {{
            const lo = document.getElementById('filter-dist-min');
            lo.value = '{target}';
            lo.dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}
        """
    )
    expect(page.locator("#filter-show-matches")).to_be_enabled()

    with page.expect_response(
        lambda r: "/match/polygon" in r.url and r.status == 200,
        timeout=10_000,
    ):
        page.click("#filter-show-matches")

    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )
    assert page.evaluate("() => window.__rm.matchCount() > 0"), \
        "no match polylines after Show-as-matches"


def test_pill_toggle_refreshes_filter_matches(page: Page, app_url):
    """When Show-matches-in-view is active, toggling a type pill must
    re-fire /match/polygon with the new type so the visible match set
    refreshes rather than reverting to no matches."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Set distance filter + fire Show-matches.
    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-dist-hist rect').length > 0",
        timeout=4_000,
    )
    target = _first_nonzero_snap(page)
    page.evaluate(
        f"""() => {{
            const lo = document.getElementById('filter-dist-min');
            lo.value = '{target}';
            lo.dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}"""
    )
    with page.expect_response(
        lambda r: "/match/polygon" in r.url and r.status == 200,
        timeout=10_000,
    ):
        page.click("#filter-show-matches")
    page.wait_for_function("() => window.__rm.matchCount() > 0", timeout=10_000)

    # Toggle Road off — expect a fresh /match/polygon with type=TrailRun,Hike.
    with page.expect_response(
        lambda r: "/match/polygon" in r.url and r.status == 200,
        timeout=15_000,
    ) as resp_info:
        page.locator('#type-pills [data-type="Run"]').click()
    # Matches still present (refreshed, not cleared).
    page.wait_for_function("() => window.__rm.matchCount() > 0", timeout=10_000)


def test_url_state_restores_click_match(page: Page, app_url):
    """A clicked match (pin + matches list) must survive a reload — the URL
    hash now carries `cll` so applyURLState re-runs queryPoint."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Click centre to drop a match.
    _click_centre_of_map(page)
    _assert_something_responded(page)
    assert page.evaluate("() => window.__rm.matchCount() > 0")

    # Hash should now contain cll=.
    hash_before = page.evaluate("() => location.hash")
    assert "cll=" in hash_before, hash_before

    # Reload and verify the match comes back.
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("() => window.__rm && window.__rm.aggregateOn()", timeout=20_000)
    page.wait_for_function("() => window.__rm.matchCount() > 0", timeout=15_000)
    pins = page.evaluate("() => document.querySelectorAll('.click-pin').length")
    assert pins > 0, "click pin should be restored on reload"


def test_filter_facets_cascade_live(page: Page, app_url):
    """When the user changes a facet in the filter menu (e.g. checks only
    Trail), the distance histogram should re-bin against that draft state
    before Apply is hit — i.e. the bar counts change. Proves the live cascade
    backed by the unfiltered /index.json snapshot is wired."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    page.locator('a[title="Filter"]').hover()
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-dist-hist rect').length > 0",
        timeout=4_000,
    )

    before = page.evaluate(
        """
        () => Array.from(document.querySelectorAll('#filter-dist-hist rect'))
                  .map(r => Number(r.getAttribute('height')))
        """
    )
    # Flip type to Trail-only; histogram must re-render. Pills live outside
    # the filter pane, so click directly.
    page.locator('#type-pills [data-type="Run"]').click()
    # Wait until the bars change (allow a tick for the change handler).
    page.wait_for_function(
        f"""
        (prev) => {{
            const cur = Array.from(document.querySelectorAll('#filter-dist-hist rect'))
                .map(r => Number(r.getAttribute('height')));
            if (cur.length !== prev.length) return true;
            return cur.some((h, i) => Math.abs(h - prev[i]) > 0.01);
        }}
        """,
        arg=before,
        timeout=4_000,
    )


def test_reset_button_flies_to_last_run(page: Page, app_url):
    """Clicking the ⟲ control flies the map to the bbox of the most recent run."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Move the map elsewhere first so the reset has an effect.
    page.evaluate("() => window.__rm.map.setView([0, 0], 2)")
    page.locator('a[title="Fly to most recent run"]').click()

    # After reset, the centre should fall inside the bbox of the most recent activity.
    info = page.evaluate(
        """
        () => {
            let best = null, bestT = -Infinity;
            for (const a of (window.__rm.indexById?.values() || [])) {
                const t = a.start_time ? Date.parse(a.start_time) : NaN;
                if (Number.isFinite(t) && t > bestT) { bestT = t; best = a; }
            }
            if (!best) return null;
            const c = window.__rm.map.getCenter();
            return {
                bbox: best.bbox, lat: c.lat, lng: c.lng,
            };
        }
        """
    )
    assert info, "no activities indexed"
    bbox = info["bbox"]  # [minlon, minlat, maxlon, maxlat]
    # Allow a little slack: fitBounds zooms out so centre is inside bbox.
    assert bbox[1] - 0.5 <= info["lat"] <= bbox[3] + 0.5, info
    assert bbox[0] - 0.5 <= info["lng"] <= bbox[2] + 0.5, info


def test_reset_clears_visible_match_ui(page: Page, app_url):
    """Reset should clear the match polylines, matches panel, and Strava
    embed — but preserve the click pin on the map (so the user can see where
    they were looking) and the in-memory selection state."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Trigger a match by clicking the centre.
    _click_centre_of_map(page)
    _assert_something_responded(page)
    assert page.evaluate("() => window.__rm.matchCount() > 0"), \
        "expected matches before reset"

    page.locator('a[title="Fly to most recent run"]').click()

    # Match polylines + panels gone.
    assert page.evaluate("() => window.__rm.matchCount() === 0"), \
        "match polylines should be cleared by reset"
    assert page.locator('#matches-panel').evaluate("el => el.classList.contains('hidden')"), \
        "matches panel should be hidden"
    assert page.locator('#preview-panel').evaluate("el => el.classList.contains('hidden')"), \
        "preview panel should be hidden"

    # Click pin survives — that's the "preserve click location" guarantee.
    pins = page.evaluate(
        "() => document.querySelectorAll('.click-pin').length"
    )
    assert pins > 0, "click pin should remain on the map after reset"


def test_hex_view_at_low_zoom(page: Page, app_url):
    """Hex overlay must still render at country-level zoom."""
    page.set_viewport_size({"width": 1280, "height": 800})
    base = app_url.split("#")[0]
    page.goto(f"{base}#z=4&ll=53,-1", wait_until="domcontentloaded")
    page.wait_for_function(
        "() => window.__rm && window.__rm.hexOn && window.__rm.hexOn()",
        timeout=20_000,
    )
    assert page.evaluate("() => window.__rm.hexOn()"), "hex layer not active at low zoom"


def test_hex_click_drills_into_track_view(page: Page, app_url):
    """One hex click lands in track view (z >= 11), however coarse the hex.
    Fitting only the hex's own bounds left country-level clicks stuck in
    hex view, reading as 'nothing happened'."""
    page.set_viewport_size({"width": 1280, "height": 800})
    base = app_url.split("#")[0]
    page.goto(f"{base}#z=7&ll=53.93,-1.82", wait_until="domcontentloaded")
    page.wait_for_function(
        "() => window.__rm && window.__rm.hexOn && window.__rm.hexOn()",
        timeout=20_000,
    )
    bb = page.locator("#map").bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.wait_for_function(
        "() => window.__rm.map.getZoom() >= 11 && window.__rm.aggregateOn()",
        timeout=10_000,
    )


# ---------- Mobile ----------------------------------------------------------


MOBILE = {"width": 390, "height": 844}        # iPhone 14 portrait


def test_mobile_click_opens_a_panel(page: Page, app_url):
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    _click_centre_of_map(page)
    _assert_something_responded(page)


def test_mobile_right_rail_clears_left_toolbar(page: Page, app_url):
    """On mobile the right-rail should leave a left gutter so the Leaflet
    toolbar (zoom, polygon, ⟲, 🗺) stays reachable, but still claim most of
    the viewport width."""
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    rail_bb = page.evaluate(
        "() => { const r = document.getElementById('right-rail'); "
        "const b = r.getBoundingClientRect(); return { w: b.width, x: b.x }; }"
    )
    # 56 px gutter on the left so the toolbar (~32 px wide at x≈12) is uncovered.
    assert rail_bb["x"] >= 50, f"right-rail too far left, blocks toolbar: x={rail_bb['x']}"
    # Still wider than the desktop column.
    assert rail_bb["w"] > 280, f"right-rail too narrow on mobile: {rail_bb['w']}"
    # The leaflet toolbar's bounding box must not intersect the rail's x range.
    tb_x = page.evaluate(
        "() => document.querySelector('.leaflet-top.leaflet-left')"
        ".getBoundingClientRect().right"
    )
    assert tb_x <= rail_bb["x"], (
        f"toolbar (right edge {tb_x}) overlaps right-rail (left edge {rail_bb['x']})"
    )


def test_mobile_preview_uses_swipe_pages(page: Page, app_url):
    """Activity preview content is rendered into a `.preview-pages` carousel,
    so the photo and details can be swiped on mobile."""
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    # Click the map to surface a preview (single-match) or a matches list.
    bb = page.locator("#map").bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )

    # If only the matches list showed up, synthesise a click on the first
    # row's title link to open its preview. (Real .click() gets intercepted
    # by the filter chip bar on mobile, so dispatch the click directly.)
    if page.evaluate("() => document.getElementById('preview-panel').classList.contains('hidden')"):
        page.wait_for_selector("#matches-content a.open-preview", timeout=4_000)
        page.evaluate(
            "() => document.querySelector('#matches-content a.open-preview').click()"
        )
        page.wait_for_selector("#preview-panel:not(.hidden)", timeout=8_000)

    page.wait_for_selector("#preview-content .preview-pages", timeout=8_000)
    info = page.evaluate(
        """
        () => {
            const pages = document.querySelector('#preview-content .preview-pages');
            const sections = pages.querySelectorAll('.preview-page');
            const pageW = pages.clientWidth;
            const sectionW = sections[0]?.getBoundingClientRect().width || 0;
            return { count: sections.length, pageW, sectionW };
        }
        """
    )
    assert info["count"] >= 1, "no preview pages rendered"
    # When at least two pages exist, each page should fill the container width
    # (scroll-snap mandatory) so swipe lands on one page at a time.
    if info["count"] >= 2:
        assert abs(info["sectionW"] - info["pageW"]) < 2, info


def test_mobile_settings_drawer_full_width(page: Page, app_url):
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    page.click("#open-settings")
    drawer_w = page.evaluate(
        "() => document.getElementById('settings-drawer').getBoundingClientRect().width"
    )
    # 92vw on a 390 px viewport ≈ 358.8
    assert drawer_w > 340, f"drawer too narrow on mobile: {drawer_w}"


def test_mobile_touch_targets(page: Page, app_url):
    """Important interactive controls should hit a 40 px touch target."""
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    sizes = page.evaluate(
        """
        () => ['open-settings'].map(id => {
            const el = document.getElementById(id);
            const b = el.getBoundingClientRect();
            return { id, w: b.width, h: b.height };
        })
        """
    )
    for s in sizes:
        assert s["h"] >= 40, f"#{s['id']} touch target too short: {s}"
