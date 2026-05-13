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

from playwright.sync_api import Page, expect


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


def test_heatmap_toggle(page: Page, app_url):
    """The heatmap overlay lives in the 🗺 display popover and toggles the
    heatmap layer on the map."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Open the display popover via its title-tagged Leaflet control.
    page.locator('a[title="Display"]').click()
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
    page.locator('a[title="Display"]').click()
    page.locator("#display-menu").wait_for(state="visible", timeout=3_000)
    page.check("#heatmap-toggle")
    page.wait_for_function("() => window.__rm.heatmapOn()", timeout=10_000)

    # Click the centre of the map — should produce matches.
    bb = page.locator("#map").bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.wait_for_selector(
        "#matches-panel:not(.hidden), #preview-panel:not(.hidden)", timeout=8_000
    )

    # Heatmap must be off-map while a match is showing.
    assert not page.evaluate("() => window.__rm.heatmapOn()"), \
        "heatmap should be hidden while a match is active"


def test_filter_chip_flow(page: Page, app_url):
    """Adding a year filter via the chip bar should refetch data and the
    chip should appear; clearing the chip should reset."""
    page.set_viewport_size({"width": 1280, "height": 800})
    _seed_map(page, app_url)

    # Open the add-filter menu and pick the first available year.
    page.click("#add-filter")
    page.locator("#filter-menu").wait_for(state="visible", timeout=3_000)
    # Select the first year option.
    page.evaluate("""
        () => {
            const sel = document.getElementById('filter-year');
            if (sel.options.length) sel.options[0].selected = true;
        }
    """)
    page.click("#filter-apply")

    # Chip bar should now contain a year chip.
    page.wait_for_selector("#filter-chips .chip", timeout=5_000)
    assert page.evaluate("() => document.querySelectorAll('#filter-chips .chip').length") == 1

    # Remove the chip via its × button → chip disappears.
    page.click("#filter-chips .chip .x")
    page.wait_for_function(
        "() => document.querySelectorAll('#filter-chips .chip').length === 0",
        timeout=5_000,
    )


def test_hex_view_at_low_zoom(page: Page, app_url):
    """Hex overlay must still render at country-level zoom."""
    page.set_viewport_size({"width": 1280, "height": 800})
    base = app_url.split("#")[0]
    page.goto(f"{base}#z=4&ll=53,-1&preset=all", wait_until="domcontentloaded")
    page.wait_for_function(
        "() => window.__rm && window.__rm.hexOn && window.__rm.hexOn()",
        timeout=20_000,
    )
    assert page.evaluate("() => window.__rm.hexOn()"), "hex layer not active at low zoom"


# ---------- Mobile ----------------------------------------------------------


MOBILE = {"width": 390, "height": 844}        # iPhone 14 portrait


def test_mobile_click_opens_a_panel(page: Page, app_url):
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    _click_centre_of_map(page)
    _assert_something_responded(page)


def test_mobile_right_rail_full_width(page: Page, app_url):
    page.set_viewport_size(MOBILE)
    _seed_map(page, app_url)

    rail_bb = page.evaluate(
        "() => { const r = document.getElementById('right-rail'); "
        "const b = r.getBoundingClientRect(); return { w: b.width, x: b.x }; }"
    )
    # On a 390 px viewport the rail should be much wider than the desktop's
    # 360 px column; it should fill (viewport - margins).
    assert rail_bb["w"] > 320, f"right-rail too narrow on mobile: {rail_bb['w']}"
    assert rail_bb["w"] < 380, f"right-rail too wide on mobile: {rail_bb['w']}"


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
