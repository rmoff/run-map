"""Shared activity-type vocabulary for the ingest paths and the API.

Both ingest modules and `api.py` need the same answer to "which Strava
sport types do we import?", but `ingest_bulk` must stay importable without
httpx, so the vocabulary lives in this dependency-free module.

Hike and Walk are treated as one activity type: both are stored under the
canonical value "Hike". Everything in IMPORT_TYPES imports at any distance
— the hike/walk minimum-distance threshold is applied at serve time
(RUN_MAP_HIKE_MIN_KM in api.py), so changing it never needs a re-import.
"""

from __future__ import annotations

RUN_TYPES = {"Run", "TrailRun"}
HIKE_SPORT_TYPES = {"Hike", "Walk"}
CANONICAL_HIKE = "Hike"
IMPORT_TYPES = RUN_TYPES | HIKE_SPORT_TYPES

# Default serve-time threshold (metres) for hikes/walks.
HIKE_MIN_DISTANCE_M = 5000.0


def canonical_type(t: str) -> str:
    """Map a Strava sport type to its stored value ("Walk" -> "Hike")."""
    return CANONICAL_HIKE if t in HIKE_SPORT_TYPES else t
