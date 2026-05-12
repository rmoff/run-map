"""Shared Playwright fixtures.

The tests assume the app is running locally — start it with
`docker compose up -d` (or `uvicorn run_map.api:app`) before running pytest.
"""

import os
import pytest

BASE_URL = os.environ.get("RUN_MAP_URL", "http://localhost:8501")

# A URL hash that puts the map into a known state with tracks visible.
# Saves us from depending on the user's persisted state.
SAVED_VIEW_HASH = "#z=14&ll=53.93,-1.82&preset=recent90"


@pytest.fixture
def app_url() -> str:
    return f"{BASE_URL}/{SAVED_VIEW_HASH}"
