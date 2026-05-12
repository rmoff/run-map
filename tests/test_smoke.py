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
    with page.expect_response(
        lambda r: "/tracks.geojson" in r.url and r.status == 200, timeout=15_000
    ):
        page.goto(app_url, wait_until="domcontentloaded")
    # Give Leaflet a tick to instantiate the GeoJSON layers + canvas.
    page.wait_for_selector(".leaflet-overlay-pane canvas", timeout=10_000)
    page.wait_for_timeout(300)


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
