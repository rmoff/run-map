# Tests

Playwright smoke tests for the desktop and mobile UI.

## Setup

```bash
pip install pytest-playwright
playwright install chromium
```

## Run

The app must already be running (`docker compose up -d`).

```bash
pytest tests/
```

Set `RUN_MAP_URL` to point at a non-local instance:

```bash
RUN_MAP_URL=http://otherhost:8501 pytest tests/
```

## What's covered

| Test | Viewport | What it checks |
|---|---|---|
| `test_desktop_click_opens_a_panel`     | 1280×800 | Clicking the map opens matches *or* preview |
| `test_desktop_settings_drawer`         | 1280×800 | ⚙ button toggles the drawer |
| `test_mobile_click_opens_a_panel`      | 390×844  | Same flow at iPhone-14 portrait |
| `test_mobile_right_rail_full_width`    | 390×844  | Matches rail spans (viewport − margins) |
| `test_mobile_settings_drawer_full_width` | 390×844 | Drawer ≥ ~92 vw on phone |
| `test_mobile_touch_targets`            | 390×844  | Key interactive controls hit ≥ 40 px |
