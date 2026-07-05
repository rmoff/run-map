"""Unit tests for the shared activity-type vocabulary.

The hike/walk distance threshold is a serve-time concern (see
RUN_MAP_HIKE_MIN_KM in api.py) — ingest admits every activity in
IMPORT_TYPES regardless of length.
"""

from __future__ import annotations

from run_map.activity_types import IMPORT_TYPES, RUN_TYPES, canonical_type


def test_import_types_cover_runs_and_hikes():
    assert RUN_TYPES == {"Run", "TrailRun"}
    assert IMPORT_TYPES == {"Run", "TrailRun", "Hike", "Walk"}


def test_canonical_type_collapses_walk_into_hike():
    assert canonical_type("Walk") == "Hike"
    assert canonical_type("Hike") == "Hike"
    assert canonical_type("Run") == "Run"
    assert canonical_type("TrailRun") == "TrailRun"
    # Unknown types pass through untouched — filtering is the caller's job.
    assert canonical_type("Ride") == "Ride"
