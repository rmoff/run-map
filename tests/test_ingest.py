"""Ingest-path tests: type admission, Walk->Hike normalisation, >5km hike gate.

Both paths run against a fresh temp DuckDB. The bulk path uses a synthetic
export directory; the Strava path monkeypatches the two API calls so no
network is involved.
"""

from __future__ import annotations

import importlib
import textwrap
from pathlib import Path

import pytest


@pytest.fixture
def fresh_db(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("RUN_MAP_DB", str(tmp_path / "test.duckdb"))
    from run_map import db as db_mod
    importlib.reload(db_mod)
    yield db_mod


GPX = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="53.50" lon="-1.50"><time>2025-01-01T08:00:00Z</time></trkpt>
        <trkpt lat="53.502" lon="-1.501"><time>2025-01-01T08:01:00Z</time></trkpt>
        <trkpt lat="53.503" lon="-1.503"><time>2025-01-01T08:02:00Z</time></trkpt>
      </trkseg></trk>
    </gpx>
    """)


def _make_export(tmp_path: Path, rows: list[dict]) -> Path:
    export = tmp_path / "export"
    (export / "activities").mkdir(parents=True)
    header = "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time,Filename"
    lines = [header]
    for r in rows:
        fname = f"activities/{r['id']}.gpx"
        (export / fname).write_text(GPX)
        lines.append(
            f"{r['id']},\"Jan 1, 2025, 8:00:00 AM\",{r['name']},{r['type']},{r['km']},1800,{fname}"
        )
    (export / "activities.csv").write_text("\n".join(lines) + "\n")
    return export


def _stored_types(db_mod) -> dict[int, str]:
    conn = db_mod.connect()
    try:
        return dict(conn.execute("SELECT id, type FROM activities").fetchall())
    finally:
        conn.close()


def test_bulk_ingest_admits_long_hikes_and_walks(fresh_db, tmp_path):
    from run_map import ingest_bulk
    importlib.reload(ingest_bulk)

    export = _make_export(tmp_path, [
        {"id": 1, "name": "morning run", "type": "Run", "km": 3.0},
        {"id": 2, "name": "big hike", "type": "Hike", "km": 12.0},
        {"id": 3, "name": "long walk", "type": "Walk", "km": 7.5},
        {"id": 4, "name": "short stroll", "type": "Walk", "km": 2.0},
        {"id": 5, "name": "commute", "type": "Ride", "km": 20.0},
    ])
    inserted, skipped = ingest_bulk.ingest(export)

    stored = _stored_types(fresh_db)
    assert stored == {1: "Run", 2: "Hike", 3: "Hike"}
    assert inserted == 3
    # The short walk is skipped by the distance gate (the Ride never enters
    # the loop — it's dropped by the type filter, not counted as skipped).
    assert skipped == 1


def test_bulk_ingest_missing_csv_raises_normal_exception(fresh_db, tmp_path):
    """A missing activities.csv must raise a regular exception, not
    SystemExit — SystemExit is silently swallowed by worker threads, which
    wedges the import state machine with running=True forever."""
    from run_map import ingest_bulk
    importlib.reload(ingest_bulk)

    empty = tmp_path / "empty-export"
    empty.mkdir()
    with pytest.raises(FileNotFoundError):
        ingest_bulk.ingest(empty)


def test_bulk_ingest_survives_corrupt_rows(fresh_db, tmp_path):
    """One unreadable track file or malformed CSV cell must not abort the
    import — remaining rows still ingest and the skip is counted."""
    from run_map import ingest_bulk
    importlib.reload(ingest_bulk)

    export = _make_export(tmp_path, [
        {"id": 1, "name": "good run", "type": "Run", "km": 5.0},
        {"id": 2, "name": "corrupt", "type": "Run", "km": 5.0},
        {"id": 3, "name": "also good", "type": "Run", "km": 5.0},
    ])
    (export / "activities/2.gpx").write_text("<gpx><trk><trkseg>")  # truncated XML
    # Blank Moving Time cell on row 3 (pandas reads it as NaN).
    csv = (export / "activities.csv").read_text().replace(
        "also good,Run,5.0,1800", "also good,Run,5.0,")
    (export / "activities.csv").write_text(csv)

    inserted, skipped = ingest_bulk.ingest(export)

    stored = _stored_types(fresh_db)
    assert set(stored) == {1, 3}, f"rows after the corrupt one must ingest: {stored}"
    assert inserted == 2
    assert skipped == 1


def test_strava_sync_admits_long_hikes_and_gates_short_ones(fresh_db, monkeypatch):
    from run_map import ingest_strava
    importlib.reload(ingest_strava)

    activities = [
        {"id": 10, "sport_type": "Run", "distance": 3000.0,
         "start_date": "2025-01-01T08:00:00Z", "name": "run", "moving_time": 900},
        {"id": 11, "sport_type": "Walk", "distance": 8000.0,
         "start_date": "2025-01-02T08:00:00Z", "name": "walk", "moving_time": 5400},
        {"id": 12, "sport_type": "Hike", "distance": 4000.0,
         "start_date": "2025-01-03T08:00:00Z", "name": "short hike", "moving_time": 3000},
        {"id": 13, "sport_type": "Ride", "distance": 30000.0,
         "start_date": "2025-01-04T08:00:00Z", "name": "ride", "moving_time": 3600},
    ]
    stream_calls: list[int] = []

    monkeypatch.setattr(ingest_strava, "_list_activities",
                        lambda client, after_epoch, on_wait=None: activities)

    def fake_stream(client, activity_id, on_wait=None):
        stream_calls.append(activity_id)
        return [(53.50, -1.50), (53.502, -1.501), (53.503, -1.503)]

    monkeypatch.setattr(ingest_strava, "_get_latlng_stream", fake_stream)

    inserted, skipped = ingest_strava.sync_with_tokens({"access_token": "t"})

    stored = _stored_types(fresh_db)
    assert stored == {10: "Run", 11: "Hike"}
    assert inserted == 2
    assert skipped == 2
    # The gate must fire before the expensive stream fetch: no stream call
    # for the short hike or the ride.
    assert sorted(stream_calls) == [10, 11]
