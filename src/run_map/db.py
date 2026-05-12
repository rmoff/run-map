from __future__ import annotations

import os
from pathlib import Path

import duckdb

DB_PATH = Path(os.environ.get("RUN_MAP_DB", "runs.duckdb")).resolve()

SCHEMA_SQL = """
INSTALL spatial;
LOAD spatial;

CREATE TABLE IF NOT EXISTS activities (
    id            BIGINT PRIMARY KEY,
    start_time    TIMESTAMP,
    name          VARCHAR,
    distance_m    DOUBLE,
    moving_time_s INTEGER,
    type          VARCHAR,
    strava_url    VARCHAR,
    source        VARCHAR,
    track         GEOMETRY
);

CREATE TABLE IF NOT EXISTS activity_details (
    id           BIGINT PRIMARY KEY,
    fetched_at   TIMESTAMP,
    summary_json VARCHAR,
    streams_json VARCHAR
);
"""


def connect(path: Path | str = DB_PATH) -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect(str(path))
    conn.execute(SCHEMA_SQL)
    return conn


def upsert_activity(
    conn: duckdb.DuckDBPyConnection,
    *,
    id: int,
    start_time,
    name: str,
    distance_m: float,
    moving_time_s: int,
    type: str,
    strava_url: str,
    source: str,
    track_wkt: str,
) -> None:
    conn.execute(
        """
        INSERT INTO activities
            (id, start_time, name, distance_m, moving_time_s, type, strava_url, source, track)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?))
        ON CONFLICT (id) DO UPDATE SET
            start_time    = EXCLUDED.start_time,
            name          = EXCLUDED.name,
            distance_m    = EXCLUDED.distance_m,
            moving_time_s = EXCLUDED.moving_time_s,
            type          = EXCLUDED.type,
            strava_url    = EXCLUDED.strava_url,
            source        = EXCLUDED.source,
            track         = EXCLUDED.track
        """,
        [id, start_time, name, distance_m, moving_time_s, type, strava_url, source, track_wkt],
    )


def max_start_time(conn: duckdb.DuckDBPyConnection):
    row = conn.execute("SELECT max(start_time) FROM activities").fetchone()
    return row[0] if row else None
