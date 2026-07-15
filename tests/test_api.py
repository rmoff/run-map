"""API-level unit tests.

These run without a live server. Each test gets a temp DuckDB seeded
with a handful of synthetic tracks, points the app at it, and exercises
one endpoint via FastAPI's TestClient.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

import pytest


@pytest.fixture
def app_client(tmp_path: Path, monkeypatch):
    """Spin up the FastAPI app against a fresh DuckDB in tmp_path.

    Imports happen inside the fixture so the RUN_MAP_DB env var is set
    before `db.DB_PATH` is computed.
    """
    db_path = tmp_path / "test.duckdb"
    monkeypatch.setenv("RUN_MAP_DB", str(db_path))

    # Reload modules so DB_PATH picks up the env var.
    import importlib
    from run_map import db as db_mod
    importlib.reload(db_mod)
    from run_map import api as api_mod
    importlib.reload(api_mod)

    from fastapi.testclient import TestClient

    # Ensure each test starts with empty caches. Point the disk cache at
    # tmp_path so concurrent runs / accidental shared state can't pollute.
    api_mod._CACHE_DIR = tmp_path / "cache"
    api_mod._invalidate_caches()

    yield TestClient(api_mod.app), db_mod, api_mod


def _seed(conn, *, id: int, type_: str = "Run", coords=None,
          start="2025-01-01T08:00:00", **enrich):
    if coords is None:
        # A zig-zag — straight-line simplification would collapse a perfectly
        # linear track to just endpoints, which hides the dedupe behaviour we
        # want to test.
        coords = [(-1.50, 53.50), (-1.501, 53.502), (-1.503, 53.503),
                  (-1.505, 53.504), (-1.508, 53.506)]
    wkt_pts = ", ".join(f"{x} {y}" for x, y in coords)
    from run_map import db as db_mod
    db_mod.upsert_activity(
        conn,
        id=id,
        start_time=datetime.fromisoformat(start),
        name=f"Run {id}",
        distance_m=5000.0,
        moving_time_s=1800,
        type=type_,
        strava_url=f"https://www.strava.com/activities/{id}",
        source="test",
        track_wkt=f"LINESTRING({wkt_pts})",
        **enrich,
    )


# ---- /index.json ---------------------------------------------------------


def test_index_json_shape(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run")
    _seed(conn, id=2, type_="TrailRun",
          coords=[(-1.6, 53.6), (-1.61, 53.61)])

    r = client.get("/index.json")
    assert r.status_code == 200
    data = r.json()
    assert "activities" in data
    assert len(data["activities"]) == 2

    a = next(x for x in data["activities"] if x["id"] == 1)
    assert a["type"] == "Run"
    assert a["start_time"].startswith("2025-01-01")
    assert isinstance(a["samples"], list)
    assert all(len(s) == 2 for s in a["samples"])
    assert len(a["bbox"]) == 4  # minlon, minlat, maxlon, maxlat


def test_index_json_empty(app_client):
    client, *_ = app_client
    r = client.get("/index.json")
    assert r.status_code == 200
    assert r.json() == {"activities": []}


# ---- /aggregate.geojson --------------------------------------------------


def _agg_total(j: dict) -> int:
    """Total deduped segments across all bucket features."""
    return sum(f["properties"]["segment_count"] for f in j["features"])


def test_aggregate_buckets_by_visit_count(app_client):
    """The aggregate carries three worn-path buckets: segments visited once
    ('low'), 2-10 times ('mid'), and >10 times ('high'), so the client can
    weight habitual routes heavier than one-offs."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    shared = [(-1.50, 53.50), (-1.501, 53.502), (-1.503, 53.503),
              (-1.505, 53.504), (-1.508, 53.506)]
    lone = [(2.00, 48.00), (2.002, 48.001), (2.004, 48.003)]
    _seed(conn, id=1, coords=shared)
    _seed(conn, id=2, coords=shared)   # same path twice -> visits=2 -> mid
    _seed(conn, id=3, coords=lone)     # once -> low

    j = client.get("/aggregate.geojson").json()
    by_bucket = {f["properties"]["bucket"]: f for f in j["features"]}
    assert set(by_bucket) == {"low", "mid", "high"}

    assert by_bucket["mid"]["properties"]["segment_count"] > 0, \
        "the twice-run path must land in the mid bucket"
    assert by_bucket["low"]["properties"]["segment_count"] > 0, \
        "the once-run path must land in the low bucket"
    assert by_bucket["high"]["properties"]["segment_count"] == 0

    # A segment lives in exactly one bucket.
    assert _agg_total(j) == sum(
        len(f["geometry"]["coordinates"]) for f in j["features"])


def test_aggregate_dedupes_overlapping_segments(app_client):
    """Two tracks that traverse the same path produce fewer segments in
    the aggregate than two non-overlapping tracks of the same length."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    shared = [(-1.50, 53.50), (-1.501, 53.502), (-1.503, 53.503),
              (-1.505, 53.504), (-1.508, 53.506)]
    disjoint = [(2.00, 48.00), (2.002, 48.001), (2.004, 48.003),
                (2.005, 48.005), (2.007, 48.007)]

    _seed(conn, id=1, coords=shared)
    _seed(conn, id=2, coords=shared)
    r_overlap = client.get("/aggregate.geojson")
    overlap_segs = _agg_total(r_overlap.json())

    # Replace the duplicate with a disjoint track to act as the baseline.
    from run_map import api as api_mod
    db_mod.upsert_activity(
        conn, id=2,
        start_time=datetime.fromisoformat("2025-01-02T08:00:00"),
        name="disjoint", distance_m=5000.0, moving_time_s=1800,
        type="Run", strava_url="x", source="test",
        track_wkt="LINESTRING(" + ", ".join(f"{x} {y}" for x, y in disjoint) + ")",
    )
    api_mod._invalidate_caches()
    r_disjoint = client.get("/aggregate.geojson")
    disjoint_segs = _agg_total(r_disjoint.json())

    assert overlap_segs < disjoint_segs, \
        f"dedupe didn't shrink output: overlap={overlap_segs} vs disjoint={disjoint_segs}"


def _zigzag(n: int = 60, x0: float = -1.5, y0: float = 53.5,
            dx: float = 1.2e-4) -> list[tuple[float, float]]:
    # Mixed-bearing zigzag with vertex spacing finer than the coarsest LOD's
    # grid (4.5e-4°) so each LOD produces a visibly different segment count.
    return [(x0 + i * dx, y0 + ((i * 7) % 5) * 1.0e-4) for i in range(n)]


def test_aggregate_lod_grid_sizes(app_client):
    """Coarser grids must dedupe more aggressively: high > mid > low.

    The same underlying track is rebuilt at each LOD; we expect strictly
    decreasing segment counts as the grid coarsens (with enough vertices
    that grid-cell collisions actually differ between bands).
    """
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, coords=_zigzag())

    counts = {}
    for lod in ("low", "mid", "high"):
        r = client.get(f"/aggregate.geojson?lod={lod}")
        assert r.status_code == 200
        counts[lod] = _agg_total(r.json())

    assert counts["high"] > counts["mid"] > counts["low"], (
        f"LOD ordering broken: {counts}"
    )


def test_aggregate_lod_unknown_rejected(app_client):
    client, *_ = app_client
    r = client.get("/aggregate.geojson?lod=bogus")
    assert r.status_code == 400


def test_aggregate_lod_cache_per_band(app_client):
    """Each LOD produces a distinct cache file; fetching one doesn't satisfy another."""
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, coords=_zigzag())

    client.get("/aggregate.geojson?lod=low")
    client.get("/aggregate.geojson?lod=mid")
    client.get("/aggregate.geojson?lod=high")

    cache_files = sorted(p.name for p in api_mod._CACHE_DIR.glob("aggregate2.*.json.gz"))
    # Three distinct sig hashes, one per lod.
    assert len(cache_files) == 3, f"expected 3 lod cache files, got {cache_files}"


def test_warm_default_aggregates_writes_all_lods(app_client):
    """The ingest warm-up hook builds all three no-filter LOD caches up front."""
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, coords=_zigzag())

    api_mod._invalidate_caches()
    assert not list(api_mod._CACHE_DIR.glob("aggregate2.*.json.gz"))
    api_mod._warm_default_aggregates()
    cache_files = sorted(p.name for p in api_mod._CACHE_DIR.glob("aggregate2.*.json.gz"))
    assert len(cache_files) == 3, f"warm-up didn't pre-build all LODs: {cache_files}"


def test_aggregate_normalises_direction(app_client):
    """A track run forwards and a track run backwards over the same path
    must collapse to the same segments — not double them."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    fwd = [(-1.50, 53.50), (-1.501, 53.502), (-1.503, 53.503),
           (-1.505, 53.504), (-1.508, 53.506)]
    rev = list(reversed(fwd))
    _seed(conn, id=1, coords=fwd)
    fwd_only = _agg_total(client.get("/aggregate.geojson").json())

    _seed(conn, id=2, coords=rev)
    from run_map import api as api_mod
    api_mod._invalidate_caches()
    both = _agg_total(client.get("/aggregate.geojson").json())

    # Adding the reversed track shouldn't add new segments.
    assert both == fwd_only, f"reversed track added segments: {fwd_only} -> {both}"


# ---- /match --------------------------------------------------------------


def test_match_includes_geometry(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=42, coords=[(-1.50, 53.50), (-1.501, 53.501)])

    r = client.get("/match", params={"lat": 53.5005, "lon": -1.5005, "r": 500})
    assert r.status_code == 200
    matches = r.json()
    assert len(matches) == 1
    m = matches[0]
    assert m["id"] == 42
    assert "geometry" in m
    assert isinstance(m["geometry"], list)
    assert len(m["geometry"]) >= 2
    # Format is [lat, lng] pairs.
    assert all(len(p) == 2 for p in m["geometry"])
    assert all(abs(p[0] - 53.5) < 0.01 for p in m["geometry"])


def test_match_polygon_includes_geometry(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=99, coords=[(-1.50, 53.50), (-1.501, 53.501)])

    poly = "POLYGON((-1.51 53.49, -1.49 53.49, -1.49 53.51, -1.51 53.51, -1.51 53.49))"
    r = client.post("/match/polygon", data={"wkt": poly})
    assert r.status_code == 200
    matches = r.json()
    assert len(matches) == 1
    assert matches[0]["geometry"] and len(matches[0]["geometry"]) >= 2


def test_match_no_hit(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)

    r = client.get("/match", params={"lat": 10.0, "lon": 10.0, "r": 50})
    assert r.status_code == 200
    assert r.json() == []


# ---- Cache invalidation --------------------------------------------------


# ---- /heatmap.json -------------------------------------------------------


def test_heatmap_returns_points(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)
    _seed(conn, id=2, coords=[(2.0, 48.0), (2.001, 48.001), (2.002, 48.003)])

    r = client.get("/heatmap.json")
    assert r.status_code == 200
    data = r.json()
    assert "points" in data
    assert len(data["points"]) >= 2
    assert all(len(p) == 2 for p in data["points"])


def test_heatmap_denser_than_index_samples(app_client):
    """Heatmap must carry many more points per track than /index.json,
    otherwise the kernel paints discrete pulses instead of a line."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    # Long zig-zag — 200 vertices.
    coords = [(- 1.5 + i * 1e-4, 53.5 + (i % 2) * 1e-4) for i in range(200)]
    _seed(conn, id=1, coords=coords)

    hm = client.get("/heatmap.json").json()
    idx = client.get("/index.json").json()
    samples_in_index = len(idx["activities"][0]["samples"])
    assert len(hm["points"]) > samples_in_index * 3, \
        f"heatmap not dense enough: {len(hm['points'])} pts vs {samples_in_index} samples"


# ---- Filter params -------------------------------------------------------


def test_aggregate_filters_by_date_range(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, start="2024-06-01T08:00:00")
    _seed(conn, id=2, start="2025-06-01T08:00:00",
          coords=[(2.0, 48.0), (2.002, 48.001), (2.003, 48.003)])

    all_segs = _agg_total(client.get("/aggregate.geojson").json())

    # Window covering 2025 only — bounds are inclusive at both ends (start_time::DATE).
    y2025 = _agg_total(client.get(
        "/aggregate.geojson?date_start=2025-01-01&date_end=2025-12-31"
    ).json())
    y2024 = _agg_total(client.get(
        "/aggregate.geojson?date_start=2024-01-01&date_end=2024-12-31"
    ).json())

    assert y2025 < all_segs and y2024 < all_segs
    # Disjoint year windows should account for everything between them.
    assert y2025 + y2024 == all_segs


def test_aggregate_filters_open_ended_date(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, start="2024-06-01T08:00:00")
    _seed(conn, id=2, start="2025-06-01T08:00:00",
          coords=[(2.0, 48.0), (2.002, 48.001), (2.003, 48.003)])

    # `date_start` alone — open-ended on the upper side.
    after = client.get("/aggregate.geojson?date_start=2025-01-01").json()
    assert _agg_total(after) > 0

    # `date_end` alone — open-ended on the lower side.
    before = client.get("/aggregate.geojson?date_end=2024-12-31").json()
    assert _agg_total(before) > 0


def test_filter_clause_rejects_bad_date(app_client):
    client, *_ = app_client
    r = client.get("/aggregate.geojson?date_start=not-a-date")
    assert r.status_code == 400


def test_filter_clause_ignores_legacy_year_param(app_client):
    """Legacy URL hashes may still carry ?years=… — should be silently ignored, not 400."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)
    r = client.get("/aggregate.geojson?years=2024")
    assert r.status_code == 200


def test_index_filters_by_type(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run")
    _seed(conn, id=2, type_="TrailRun",
          coords=[(2.0, 48.0), (2.002, 48.001)])

    trail = client.get("/index.json?type=TrailRun").json()
    assert {a["id"] for a in trail["activities"]} == {2}

    road = client.get("/index.json?type=Run").json()
    assert {a["id"] for a in road["activities"]} == {1}


def test_index_filters_by_multiple_types(app_client):
    """`type=` accepts a comma-separated list (two of three pills on)."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run")
    _seed(conn, id=2, type_="TrailRun",
          coords=[(2.0, 48.0), (2.002, 48.001)])
    _seed(conn, id=3, type_="Hike",
          coords=[(3.0, 47.0), (3.002, 47.001)])

    both = client.get("/index.json?type=Run,Hike").json()
    assert {a["id"] for a in both["activities"]} == {1, 3}

    # Order-insensitive.
    rev = client.get("/index.json?type=Hike,Run").json()
    assert {a["id"] for a in rev["activities"]} == {1, 3}


def test_filter_clause_multi_type_sig_deterministic(app_client):
    """Comma-list order must not change the WHERE clause or the cache sig,
    and single-value sigs must stay plain strings (existing cache entries
    remain valid)."""
    *_, api_mod = app_client
    a = api_mod._filter_clause(type="TrailRun,Run")
    b = api_mod._filter_clause(type="Run,TrailRun")
    assert a == b

    where, params, sig = api_mod._filter_clause(type="Run")
    assert sig["type"] == "Run"
    # The serve-time hike gate is always the first clause; the type filter
    # follows as a single equality.
    assert "type = ?" in where and "Run" in params


def test_index_unknown_type_returns_empty(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run")
    r = client.get("/index.json?type=Bicycle")
    assert r.status_code == 200
    assert r.json() == {"activities": []}


def test_match_filters_by_distance(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    # Seed with explicit distances — _seed defaults to 5000m.
    from run_map import db as db_mod2
    for id_, dist in [(1, 3000.0), (2, 10000.0), (3, 25000.0)]:
        db_mod2.upsert_activity(
            conn, id=id_,
            start_time=datetime.fromisoformat("2025-01-01T08:00:00"),
            name=f"Run {id_}", distance_m=dist, moving_time_s=1800,
            type="Run", strava_url=f"https://x/{id_}", source="test",
            track_wkt="LINESTRING(-1.50 53.50, -1.501 53.502, -1.503 53.503)",
        )

    r = client.get("/match", params={
        "lat": 53.502, "lon": -1.501, "r": 500, "min_km": 5,
    })
    matches = r.json()
    assert {m["id"] for m in matches} == {2, 3}

    r = client.get("/match", params={
        "lat": 53.502, "lon": -1.501, "r": 500, "min_km": 5, "max_km": 20,
    })
    assert {m["id"] for m in r.json()} == {2}


def test_match_radius_is_isotropic(app_client):
    """The match radius must reach equally far east-west as north-south.
    Naive degree math shrinks the east-west reach by cos(latitude) — at
    lat 53.5 a 70 m east offset sat outside a nominal 100 m radius."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    import math
    # Straight north-south track through (-1.5, 53.50..53.51).
    _seed(conn, id=1, coords=[(-1.5, 53.50), (-1.5, 53.505), (-1.5, 53.51)])
    lat = 53.505
    dlon = 70 / (111_320 * math.cos(math.radians(lat)))  # 70 m east

    east = client.get("/match", params={"lat": lat, "lon": -1.5 + dlon, "r": 100}).json()
    assert {m["id"] for m in east} == {1}, "70 m east must be inside a 100 m radius"

    east_tight = client.get("/match", params={"lat": lat, "lon": -1.5 + dlon, "r": 50}).json()
    assert east_tight == [], "70 m east must be outside a 50 m radius"


def test_filter_options_endpoint(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run", start="2024-06-01T08:00:00")
    _seed(conn, id=2, type_="TrailRun", start="2025-06-01T08:00:00",
          coords=[(2.0, 48.0), (2.002, 48.001)])

    _seed(conn, id=3, type_="Hike", start="2025-07-01T08:00:00",
          coords=[(3.0, 47.0), (3.002, 47.001)])

    r = client.get("/filter-options")
    j = r.json()
    assert j["min_date"] == "2024-06-01"
    assert j["max_date"] == "2025-07-01"
    assert set(j["types"]) == {"Run", "TrailRun", "Hike"}


def test_stats_counts_three_type_buckets(app_client):
    """/stats yearly rows carry road/trail/hike; unknown legacy types keep
    counting in the road catch-all (pins today's behaviour on purpose)."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, type_="Run", start="2024-03-01T08:00:00")
    _seed(conn, id=2, type_="TrailRun", start="2024-04-01T08:00:00",
          coords=[(2.0, 48.0), (2.002, 48.001)])
    _seed(conn, id=3, type_="Hike", start="2024-05-01T08:00:00",
          coords=[(3.0, 47.0), (3.002, 47.001)])
    _seed(conn, id=4, type_="Hike", start="2025-05-01T08:00:00",
          coords=[(4.0, 46.0), (4.002, 46.001)])
    _seed(conn, id=5, type_="Workout", start="2024-06-01T08:00:00",
          coords=[(5.0, 45.0), (5.002, 45.001)])

    j = client.get("/stats").json()
    by_year = {y["year"]: y for y in j["yearly"]}
    assert by_year[2024] == {"year": 2024, "trail": 1, "hike": 1, "road": 2}
    assert by_year[2025] == {"year": 2025, "trail": 0, "hike": 1, "road": 0}


# ---- Serve-time hike threshold ---------------------------------------------


def _seed_dist(conn, *, id: int, type_: str, distance_m: float, coords, start="2025-01-01T08:00:00"):
    from run_map import db as db_mod
    wkt_pts = ", ".join(f"{x} {y}" for x, y in coords)
    db_mod.upsert_activity(
        conn, id=id, start_time=datetime.fromisoformat(start),
        name=f"A{id}", distance_m=distance_m, moving_time_s=1800, type=type_,
        strava_url=f"https://x/{id}", source="test",
        track_wkt=f"LINESTRING({wkt_pts})",
    )


def test_short_hikes_are_stored_but_not_served(app_client):
    """Hikes/walks import at any length, but everything the map serves
    excludes hikes under the threshold (default 5 km). Short runs are
    unaffected."""
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed_dist(conn, id=1, type_="Hike", distance_m=3000.0,
               coords=[(-1.5, 53.5), (-1.501, 53.502)])
    _seed_dist(conn, id=2, type_="Hike", distance_m=8000.0,
               coords=[(2.0, 48.0), (2.002, 48.001)])
    _seed_dist(conn, id=3, type_="Run", distance_m=3000.0,
               coords=[(3.0, 47.0), (3.002, 47.001)])

    idx = client.get("/index.json").json()
    assert {a["id"] for a in idx["activities"]} == {2, 3}, \
        "short hike must be hidden; short run must not"

    m = client.get("/match", params={"lat": 53.501, "lon": -1.5005, "r": 200}).json()
    assert m == [], "short hike must not match"

    stats = client.get("/stats").json()
    assert stats["count"] == 2
    assert stats["yearly"][0]["hike"] == 1


def test_hike_threshold_query_param(app_client):
    """`hike_min_km=` on the filtered endpoints overrides the server default
    per-request (each value gets its own cache signature)."""
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed_dist(conn, id=1, type_="Hike", distance_m=3000.0,
               coords=[(-1.5, 53.5), (-1.501, 53.502)])
    _seed_dist(conn, id=2, type_="Hike", distance_m=8000.0,
               coords=[(2.0, 48.0), (2.002, 48.001)])

    # Default: only the 8 km hike.
    assert {a["id"] for a in client.get("/index.json").json()["activities"]} == {2}
    # Lowered: both.
    got = client.get("/index.json?hike_min_km=2").json()
    assert {a["id"] for a in got["activities"]} == {1, 2}
    # Raised: neither.
    got = client.get("/index.json?hike_min_km=10").json()
    assert got["activities"] == []

    # /stats takes the same override so the drawer numbers agree with the map.
    s = client.get("/stats?hike_min_km=2").json()
    assert s["count"] == 2
    # And the response advertises the server default for the UI placeholder.
    assert s["hike_min_km_default"] == 5.0

    # Distinct cache signatures per value.
    a = api_mod._filter_clause(hike_min_km=2.0)[2]
    b = api_mod._filter_clause()[2]
    assert a["hike_min_m"] != b["hike_min_m"]


def test_hike_threshold_env_override(app_client, monkeypatch, tmp_path):
    """RUN_MAP_HIKE_MIN_KM changes the serve-time gate without re-import."""
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed_dist(conn, id=1, type_="Hike", distance_m=3000.0,
               coords=[(-1.5, 53.5), (-1.501, 53.502)])

    monkeypatch.setenv("RUN_MAP_HIKE_MIN_KM", "2")
    import importlib
    importlib.reload(api_mod)
    from fastapi.testclient import TestClient
    api_mod._CACHE_DIR = tmp_path / "cache2"
    client2 = TestClient(api_mod.app)

    idx = client2.get("/index.json").json()
    assert {a["id"] for a in idx["activities"]} == {1}, \
        "a 3 km hike must be served when the threshold is 2 km"


# ---- Sync state machine ----------------------------------------------------


def test_sync_kickoff_failure_resets_running_flag(app_client, monkeypatch):
    """If token refresh (or range parsing) blows up after the running flag is
    set, the flag must be reset — otherwise every later sync returns
    already_running until the server restarts."""
    client, _, api_mod = app_client
    monkeypatch.setattr(api_mod.ingest_strava, "load_config",
                        lambda: {"client_id": "x", "client_secret": "y"})
    monkeypatch.setattr(api_mod.ingest_strava, "load_tokens",
                        lambda: {"access_token": "t", "refresh_token": "r"})

    def boom(*a, **kw):
        raise RuntimeError("strava unreachable")
    monkeypatch.setattr(api_mod.ingest_strava, "refresh_tokens", boom)

    r = client.post("/strava/sync", data={"range": "Since last sync"})
    assert r.status_code == 500

    status = client.get("/strava/sync/status").json()
    assert status["running"] is False, "kickoff failure must reset running"
    assert status["phase"] == "error"

    # A retry must not be locked out.
    r2 = client.post("/strava/sync", data={"range": "Since last sync"})
    assert r2.json().get("status") != "already_running"


# ---- Static asset caching -------------------------------------------------


def test_static_assets_require_revalidation(app_client):
    """index.html and the static bundle must carry Cache-Control: no-cache so
    browsers revalidate on every load. Without it, heuristic caching serves a
    stale app.js against fresh index.html — mismatched pill logic in the UI."""
    client, *_ = app_client
    for path in ("/", "/static/app.js", "/static/style.css"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers.get("cache-control") == "no-cache", \
            f"{path}: Cache-Control={r.headers.get('cache-control')!r}"


# ---- Disk cache ----------------------------------------------------------


def test_disk_cache_writes_gzipped_file(app_client, tmp_path):
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)
    client.get("/aggregate.geojson")

    files = list(api_mod._CACHE_DIR.glob("*.json.gz"))
    assert any("aggregate" in p.name for p in files), \
        f"no aggregate cache file: {[p.name for p in files]}"

    # Verify the cached file is actually gzipped (magic bytes 1f 8b).
    p = next(p for p in files if "aggregate" in p.name)
    assert p.read_bytes()[:2] == b"\x1f\x8b"


def test_disk_cache_response_has_gzip_encoding(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)
    r = client.get("/aggregate.geojson")
    # Starlette TestClient transparently decompresses, but the header should
    # still be set so a real browser knows the response is gzipped.
    assert r.headers.get("content-encoding") == "gzip"


def test_invalidate_caches_picks_up_new_tracks(app_client):
    client, db_mod, api_mod = app_client
    conn = db_mod.connect()
    _seed(conn, id=1)

    r1 = client.get("/aggregate.geojson")
    seg1 = _agg_total(r1.json())

    # New track on a totally disjoint path, then invalidate.
    _seed(conn, id=2, coords=[(2.00, 48.00), (2.001, 48.001), (2.002, 48.002)])
    api_mod._invalidate_caches()

    r2 = client.get("/aggregate.geojson")
    seg2 = _agg_total(r2.json())
    assert seg2 > seg1

    # /index.json invalidates alongside.
    idx = client.get("/index.json").json()
    assert {a["id"] for a in idx["activities"]} == {1, 2}


# ---- Enrichment columns (gear / elevation / HR / weather) ------------------


def test_schema_migrates_existing_db(app_client, tmp_path):
    """A DB created before the enrichment columns gains them on connect."""
    _, db_mod, _ = app_client
    old = tmp_path / "old.duckdb"
    import duckdb as _duck
    c = _duck.connect(str(old))
    c.execute("""
        CREATE TABLE activities (
            id BIGINT PRIMARY KEY, start_time TIMESTAMP, name VARCHAR,
            distance_m DOUBLE, moving_time_s INTEGER, type VARCHAR,
            strava_url VARCHAR, source VARCHAR)
    """)
    c.close()
    conn = db_mod.connect(old)
    cols = {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'activities'").fetchall()}
    conn.close()
    assert {"gear", "elevation_gain_m", "avg_hr", "max_hr",
            "relative_effort", "description", "weather"} <= cols


def test_upsert_enrichment_roundtrip_and_null_preservation(app_client):
    client, db_mod, _ = app_client
    conn = db_mod.connect()
    _seed(conn, id=1, gear="Brooks Ghost 15", elevation_gain_m=320.0,
          avg_hr=142.0, max_hr=171.0, relative_effort=55.0,
          description="⛰️ Crow Wells Hill", weather_json='{"temperature_c": 5.0}')
    row = conn.execute(
        "SELECT gear, elevation_gain_m, avg_hr, max_hr, relative_effort, "
        "description, weather FROM activities WHERE id = 1").fetchone()
    assert row == ("Brooks Ghost 15", 320.0, 142.0, 171.0, 55.0,
                   "⛰️ Crow Wells Hill", '{"temperature_c": 5.0}')

    # Re-upsert the same id with no enrichment (as the API sync would for
    # description/weather) — existing values must survive.
    _seed(conn, id=1)
    row = conn.execute("SELECT gear, description, weather FROM activities WHERE id = 1").fetchone()
    assert row == ("Brooks Ghost 15", "⛰️ Crow Wells Hill", '{"temperature_c": 5.0}')

    # A non-null value still wins over the stored one.
    _seed(conn, id=1, gear="Brooks Ghost 16")
    assert conn.execute("SELECT gear FROM activities WHERE id = 1").fetchone()[0] == "Brooks Ghost 16"
