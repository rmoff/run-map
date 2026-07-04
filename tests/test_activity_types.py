"""Unit tests for the shared activity-type vocabulary and import gate."""

from __future__ import annotations

from run_map.activity_types import (
    HIKE_MIN_DISTANCE_M,
    IMPORT_TYPES,
    RUN_TYPES,
    canonical_type,
    passes_import_gate,
)


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


def test_runs_import_at_any_distance():
    assert passes_import_gate("Run", 100.0)
    assert passes_import_gate("TrailRun", 0.0)


def test_hikes_gate_on_distance():
    assert not passes_import_gate("Hike", 4900.0)
    assert not passes_import_gate("Hike", HIKE_MIN_DISTANCE_M)  # strictly greater
    assert passes_import_gate("Hike", 5001.0)


def test_hike_with_missing_distance_is_skipped():
    assert not passes_import_gate("Hike", 0.0)
