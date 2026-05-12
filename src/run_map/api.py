"""FastAPI backend — serves the Leaflet UI and the spatial query endpoints."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db, ingest_bulk, ingest_strava

app = FastAPI(title="run-map")
app.add_middleware(GZipMiddleware, minimum_size=512)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# One connection for the lifetime of the process. DuckDB allows multiple
# in-process connections to the same file, so the ingest paths that open
# their own connection work fine alongside this one.
#
# CRITICAL: DuckDB connections are NOT thread-safe. FastAPI runs sync routes
# in a threadpool, so concurrent requests can hit the same connection from
# different threads and corrupt the native heap (we've seen the process die
# with "corrupted double-linked list"). Serialise every access with a lock.
_conn = db.connect()
_conn_lock = threading.Lock()


def _db_fetchall(sql: str, params: list | None = None) -> list:
    with _conn_lock:
        return _conn.execute(sql, params or []).fetchall()


def _db_fetchone(sql: str, params: list | None = None):
    with _conn_lock:
        return _conn.execute(sql, params or []).fetchone()


def _db_exec(sql: str, params: list | None = None) -> None:
    with _conn_lock:
        _conn.execute(sql, params or [])


# ---- HTML -----------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ---- Queries --------------------------------------------------------------

_tracks_cache: dict[tuple, bytes] = {}


def _invalidate_tracks_cache() -> None:
    _tracks_cache.clear()


def _bbox_to_wkt(bbox: str) -> str | None:
    try:
        minlon, minlat, maxlon, maxlat = (float(x) for x in bbox.split(","))
    except (ValueError, AttributeError):
        return None
    return (
        f"POLYGON(({minlon} {minlat}, {maxlon} {minlat}, "
        f"{maxlon} {maxlat}, {minlon} {maxlat}, {minlon} {minlat}))"
    )


def _build_tracks_geojson(
    from_: str | None, to: str | None, bbox: str | None, exclude_bbox: str | None
) -> bytes:
    where = []
    params: list = []
    if from_:
        where.append("start_time >= ?")
        params.append(from_)
    if to:
        where.append("start_time < ?")
        params.append(to)
    if bbox:
        wkt = _bbox_to_wkt(bbox)
        if wkt:
            where.append("ST_Intersects(track, ST_GeomFromText(?))")
            params.append(wkt)
    if exclude_bbox:
        wkt = _bbox_to_wkt(exclude_bbox)
        if wkt:
            where.append("NOT ST_Intersects(track, ST_GeomFromText(?))")
            params.append(wkt)
    sql = (
        "SELECT id, start_time, name, distance_m, strava_url, type, ST_AsGeoJSON(track) "
        "FROM activities"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = _db_fetchall(sql, params)
    features = [
        {
            "type": "Feature",
            "geometry": json.loads(r[6]),
            "properties": {
                "id": r[0],
                "start_time": r[1].isoformat() if r[1] else None,
                "name": r[2],
                "distance_m": r[3],
                "strava_url": r[4],
                "activity_type": r[5],
            },
        }
        for r in rows
        if r[6]
    ]
    return json.dumps({"type": "FeatureCollection", "features": features}).encode()


@app.get("/tracks.geojson")
def tracks(
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
    bbox: str | None = Query(None),
    exclude_bbox: str | None = Query(None),
) -> Response:
    """Cached pre-serialized GeoJSON. Hot path: ~ms instead of seconds.
    Only the no-bbox variants are cached — bbox calls are rare and small."""
    if not bbox and not exclude_bbox:
        key = (from_, to)
        body = _tracks_cache.get(key)
        if body is None:
            body = _build_tracks_geojson(from_, to, None, None)
            _tracks_cache[key] = body
    else:
        body = _build_tracks_geojson(from_, to, bbox, exclude_bbox)
    return Response(content=body, media_type="application/json")


def _match_rows(rows) -> list[dict]:
    return [
        {
            "id": r[0],
            "start_time": r[1].isoformat() if r[1] else None,
            "name": r[2],
            "distance_m": r[3],
            "strava_url": r[4],
            "activity_type": r[5] if len(r) > 5 else None,
        }
        for r in rows
    ]


@app.get("/count")
def count() -> dict:
    return {"count": _db_fetchone("SELECT count(*) FROM activities")[0]}


@app.get("/stats")
def stats() -> dict:
    row = _db_fetchone(
        "SELECT count(*), min(start_time), max(start_time) FROM activities"
    )
    yearly = _db_fetchall(
        """
        SELECT EXTRACT(year FROM start_time)::INT, count(*)
        FROM activities
        WHERE start_time IS NOT NULL
        GROUP BY 1 ORDER BY 1
        """
    )
    return {
        "count": int(row[0] or 0),
        "earliest": row[1].isoformat() if row[1] else None,
        "latest": row[2].isoformat() if row[2] else None,
        "yearly": [{"year": int(y), "count": int(n)} for y, n in yearly],
    }


@app.get("/match")
def match_point(lat: float, lon: float, r: float) -> list[dict]:
    """Runs whose track came within `r` metres of (lat, lon)."""
    radius_deg = r / 111_000.0
    rows = _db_fetchall(
        """
        SELECT id, start_time, name, distance_m, strava_url, type
        FROM activities
        WHERE ST_DWithin(track, ST_Point(?, ?), ?)
        ORDER BY start_time DESC
        """,
        [lon, lat, radius_deg],
    )
    return _match_rows(rows)


@app.post("/match/polygon")
def match_polygon(
    wkt: str = Form(...),
    from_: str | None = Form(None, alias="from"),
    to: str | None = Form(None),
) -> list[dict]:
    where = ["ST_Intersects(track, ST_GeomFromText(?))"]
    params: list = [wkt]
    if from_:
        where.append("start_time >= ?")
        params.append(from_)
    if to:
        where.append("start_time < ?")
        params.append(to)
    sql = (
        "SELECT id, start_time, name, distance_m, strava_url, type "
        "FROM activities WHERE " + " AND ".join(where) + " ORDER BY start_time DESC"
    )
    rows = _db_fetchall(sql, params)
    return _match_rows(rows)


# ---- Bulk ingest ----------------------------------------------------------

@app.post("/import/zip")
async def import_zip(file: UploadFile = File(...)) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        zip_path = tmp_path / "export.zip"
        with zip_path.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp_path)
        root = tmp_path
        if not (root / "activities.csv").exists():
            nested = [p for p in tmp_path.iterdir() if p.is_dir() and (p / "activities.csv").exists()]
            if nested:
                root = nested[0]
        inserted, skipped = await asyncio.to_thread(ingest_bulk.ingest, root)
    _invalidate_tracks_cache()
    return {"inserted": inserted, "skipped": skipped}


# ---- Strava ---------------------------------------------------------------

_SYNC_RANGES = {
    "Since last sync": None,
    "Last 30 days": 30,
    "Last 12 months": 365,
    "From the beginning": "all",
}


def _range_to_epoch(label: str) -> int | None:
    if label not in _SYNC_RANGES:
        raise HTTPException(400, f"Unknown range: {label}")
    v = _SYNC_RANGES[label]
    if v is None:
        return None
    if v == "all":
        return 0
    return int((datetime.now(timezone.utc) - timedelta(days=v)).timestamp())


@app.get("/strava/status")
def strava_status() -> dict:
    cfg = ingest_strava.load_config()
    return {
        "client_id": cfg.get("client_id", ""),
        "has_creds": bool(cfg.get("client_id") and cfg.get("client_secret")),
        "has_tokens": ingest_strava.load_tokens() is not None,
    }


@app.post("/strava/config")
def strava_set_config(client_id: str = Form(...), client_secret: str = Form(...)) -> dict:
    ingest_strava.save_config(client_id.strip(), client_secret.strip())
    return {"ok": True}


@app.get("/strava/authorize_url")
def strava_get_authorize_url() -> dict:
    cfg = ingest_strava.load_config()
    if not cfg.get("client_id"):
        raise HTTPException(400, "Save credentials first")
    return {"url": ingest_strava.authorize_url(cfg["client_id"])}


@app.post("/strava/exchange")
def strava_exchange(code: str = Form(...)) -> dict:
    cfg = ingest_strava.load_config()
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        raise HTTPException(400, "Save credentials first")
    ingest_strava.exchange_code(cfg["client_id"], cfg["client_secret"], code.strip())
    return {"ok": True}


@app.get("/strava/test")
def strava_test() -> dict:
    cfg = ingest_strava.load_config()
    tokens = ingest_strava.load_tokens()
    if not tokens or not cfg.get("client_id"):
        raise HTTPException(400, "Not authorised yet")
    tokens = ingest_strava.refresh_tokens(cfg["client_id"], cfg["client_secret"], tokens)
    a = ingest_strava.athlete(tokens)
    return {"firstname": a.get("firstname", ""), "lastname": a.get("lastname", "")}


@app.post("/strava/sync")
async def strava_sync(range: str = Form("Since last sync")) -> dict:
    cfg = ingest_strava.load_config()
    tokens = ingest_strava.load_tokens()
    if not tokens or not cfg.get("client_id"):
        raise HTTPException(400, "Not authorised yet")
    tokens = ingest_strava.refresh_tokens(cfg["client_id"], cfg["client_secret"], tokens)
    since = _range_to_epoch(range)
    try:
        inserted, skipped = await asyncio.to_thread(
            ingest_strava.sync_with_tokens, tokens, since_epoch=since
        )
    except ingest_strava.DailyRateLimit as e:
        raise HTTPException(429, str(e))
    _invalidate_tracks_cache()
    return {"inserted": inserted, "skipped": skipped}


@app.get("/activity/{activity_id}")
def activity_details(activity_id: int) -> dict:
    """Hover preview data — Strava `/activities/{id}` plus altitude/distance
    streams. Cached forever in `activity_details`; activities don't change."""
    cached = _db_fetchone(
        "SELECT summary_json, streams_json FROM activity_details WHERE id = ?",
        [activity_id],
    )
    if cached:
        return {
            "summary": json.loads(cached[0]),
            "streams": json.loads(cached[1]) if cached[1] else None,
        }

    cfg = ingest_strava.load_config()
    tokens = ingest_strava.load_tokens()
    if not tokens or not cfg.get("client_id"):
        raise HTTPException(401, "Not authorised — connect Strava in settings first")
    tokens = ingest_strava.refresh_tokens(cfg["client_id"], cfg["client_secret"], tokens)

    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    with httpx.Client(headers=headers, timeout=15) as client:
        r = client.get(f"{ingest_strava.API}/activities/{activity_id}")
        if r.status_code == 429:
            raise HTTPException(429, "Strava rate limit hit — try again in a few minutes")
        if r.status_code == 404:
            raise HTTPException(404, "Activity not found on Strava")
        r.raise_for_status()
        summary = r.json()

        sr = client.get(
            f"{ingest_strava.API}/activities/{activity_id}/streams",
            params={"keys": "altitude,distance", "key_by_type": "true"},
        )
        streams = sr.json() if sr.status_code == 200 else None

    _db_exec(
        """
        INSERT INTO activity_details (id, fetched_at, summary_json, streams_json)
        VALUES (?, now(), ?, ?)
        ON CONFLICT (id) DO UPDATE SET
            fetched_at   = now(),
            summary_json = EXCLUDED.summary_json,
            streams_json = EXCLUDED.streams_json
        """,
        [activity_id, json.dumps(summary), json.dumps(streams) if streams else None],
    )

    return {"summary": summary, "streams": streams}


@app.delete("/strava/tokens")
def strava_forget_tokens() -> dict:
    ingest_strava.TOKEN_FILE.unlink(missing_ok=True)
    return {"ok": True}
