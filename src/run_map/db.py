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

-- Enrichment columns added 2026-07: nullable, backfilled by re-ingest.
-- ADD COLUMN IF NOT EXISTS keeps this a no-op migration on every connect.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS gear VARCHAR;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS elevation_gain_m DOUBLE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS avg_hr DOUBLE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS max_hr DOUBLE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS relative_effort DOUBLE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS description VARCHAR;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS weather VARCHAR;
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
    gear: str | None = None,
    elevation_gain_m: float | None = None,
    avg_hr: float | None = None,
    max_hr: float | None = None,
    relative_effort: float | None = None,
    description: str | None = None,
    weather_json: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO activities
            (id, start_time, name, distance_m, moving_time_s, type, strava_url,
             source, gear, elevation_gain_m, avg_hr, max_hr, relative_effort,
             description, weather, track)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?))
        ON CONFLICT (id) DO UPDATE SET
            start_time    = EXCLUDED.start_time,
            name          = EXCLUDED.name,
            distance_m    = EXCLUDED.distance_m,
            moving_time_s = EXCLUDED.moving_time_s,
            type          = EXCLUDED.type,
            strava_url    = EXCLUDED.strava_url,
            source        = EXCLUDED.source,
            -- Enrichment: a re-ingest that has the value wins; a path that
            -- doesn't (e.g. API sync lacks description/weather) never
            -- clobbers what a bulk import already stored.
            gear             = COALESCE(EXCLUDED.gear, gear),
            elevation_gain_m = COALESCE(EXCLUDED.elevation_gain_m, elevation_gain_m),
            avg_hr           = COALESCE(EXCLUDED.avg_hr, avg_hr),
            max_hr           = COALESCE(EXCLUDED.max_hr, max_hr),
            relative_effort  = COALESCE(EXCLUDED.relative_effort, relative_effort),
            description      = COALESCE(EXCLUDED.description, description),
            weather          = COALESCE(EXCLUDED.weather, weather),
            track         = EXCLUDED.track
        """,
        [id, start_time, name, distance_m, moving_time_s, type, strava_url,
         source, gear, elevation_gain_m, avg_hr, max_hr, relative_effort,
         description, weather_json, track_wkt],
    )


def max_start_time(conn: duckdb.DuckDBPyConnection):
    row = conn.execute("SELECT max(start_time) FROM activities").fetchone()
    return row[0] if row else None
