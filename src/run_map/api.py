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

_tls = threading.local()


def _thread_conn():
    """Each FastAPI threadpool worker holds its own DuckDB connection.

    DuckDB allows many in-process connections to the same database file;
    they coordinate internally. Sharing a single connection across threads
    is unsafe (we have crashed with "corrupted double-linked list" doing
    that), so per-thread is the right granularity. Long-running reads on
    one worker no longer block parallel reads on another."""
    c = getattr(_tls, "conn", None)
    if c is None:
        c = db.connect()
        _tls.conn = c
    return c


def _db_fetchall(sql: str, params: list | None = None) -> list:
    return _thread_conn().execute(sql, params or []).fetchall()


def _db_fetchone(sql: str, params: list | None = None):
    return _thread_conn().execute(sql, params or []).fetchone()


def _db_exec(sql: str, params: list | None = None) -> None:
    _thread_conn().execute(sql, params or [])


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
        SELECT EXTRACT(year FROM start_time)::INT AS year,
               SUM(CASE WHEN type = 'TrailRun' THEN 1 ELSE 0 END) AS trail,
               SUM(CASE WHEN type != 'TrailRun' THEN 1 ELSE 0 END) AS road
        FROM activities
        WHERE start_time IS NOT NULL
        GROUP BY 1 ORDER BY 1
        """
    )
    return {
        "count": int(row[0] or 0),
        "earliest": row[1].isoformat() if row[1] else None,
        "latest": row[2].isoformat() if row[2] else None,
        "yearly": [
            {"year": int(y), "trail": int(t or 0), "road": int(r or 0)}
            for y, t, r in yearly
        ],
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

_import_state: dict = {
    "running": False,
    "phase": "idle",         # idle | uploading | unzipping | importing | done | error
    "processed": 0,
    "total": 0,
    "inserted": 0,
    "unreadable": 0,
    "message": "",
    "error": None,
}
_import_lock = threading.Lock()


def _run_import_thread(root: Path) -> None:
    def on_progress(done: int, total: int, label: str) -> None:
        with _import_lock:
            _import_state["phase"] = "importing"
            _import_state["processed"] = done
            _import_state["total"] = total
            _import_state["message"] = f"Importing {done}/{total} · {label[:50]}"
    try:
        inserted, unreadable = ingest_bulk.ingest(root, progress_cb=on_progress)
        _invalidate_tracks_cache()
        with _import_lock:
            _import_state.update({
                "running": False, "phase": "done",
                "inserted": inserted, "unreadable": unreadable,
                "message": (
                    f"Imported {inserted} runs"
                    + (f" · {unreadable} files unreadable" if unreadable else "")
                ),
                "error": None,
            })
    except Exception as e:
        with _import_lock:
            _import_state.update({
                "running": False, "phase": "error",
                "error": str(e), "message": f"Import failed: {e}",
            })


@app.post("/import/zip")
async def import_zip(file: UploadFile = File(...)) -> dict:
    """Accept upload, extract, kick off ingest in a background thread.
    Returns immediately; poll `/import/zip/status` for progress."""
    with _import_lock:
        if _import_state["running"]:
            return {"status": "already_running"}
        _import_state.update({
            "running": True, "phase": "uploading",
            "processed": 0, "total": 0, "inserted": 0, "unreadable": 0,
            "message": "Receiving upload…", "error": None,
        })

    tmp_path = Path(tempfile.mkdtemp(prefix="run-map-import-"))
    zip_path = tmp_path / "export.zip"
    try:
        with zip_path.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
        with _import_lock:
            _import_state["phase"] = "unzipping"
            _import_state["message"] = "Unzipping export…"
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp_path)
        root = tmp_path
        if not (root / "activities.csv").exists():
            nested = [p for p in tmp_path.iterdir() if p.is_dir() and (p / "activities.csv").exists()]
            if nested:
                root = nested[0]
    except Exception as e:
        with _import_lock:
            _import_state.update({"running": False, "phase": "error", "error": str(e)})
        raise HTTPException(500, str(e))

    threading.Thread(target=_run_import_thread, args=(root,), daemon=True).start()
    return {"status": "started"}


@app.get("/import/zip/status")
def import_zip_status() -> dict:
    with _import_lock:
        return dict(_import_state)


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


# In-process sync state, polled by the UI via /strava/sync/status.
_sync_state: dict = {
    "running": False,
    "phase": "idle",       # idle | listing | processing | rate_limited | done | error
    "processed": 0,
    "total": 0,
    "inserted": 0,
    "skipped": 0,
    "message": "",
    "error": None,
}
_sync_lock = threading.Lock()


def _run_sync_thread(tokens: dict, since: int | None) -> None:
    def on_wait(seconds: int) -> None:
        mins = max(1, seconds // 60)
        with _sync_lock:
            _sync_state["phase"] = "rate_limited"
            _sync_state["message"] = f"Strava rate-limited — waiting ~{mins} min for next window"

    def on_progress(state: dict) -> None:
        with _sync_lock:
            _sync_state.update(state)
            _sync_state["running"] = True

    try:
        inserted, skipped = ingest_strava.sync_with_tokens(
            tokens, since_epoch=since, on_wait=on_wait, on_progress=on_progress
        )
        _invalidate_tracks_cache()
        with _sync_lock:
            _sync_state.update({
                "running": False, "phase": "done",
                "inserted": inserted, "skipped": skipped,
                "message": (
                    f"Synced {inserted} runs"
                    + (f" · {skipped} other-sport / no-GPS ignored" if skipped else "")
                ),
                "error": None,
            })
    except ingest_strava.DailyRateLimit as e:
        with _sync_lock:
            _sync_state.update({
                "running": False, "phase": "error",
                "error": str(e), "message": str(e),
            })
    except Exception as e:
        with _sync_lock:
            _sync_state.update({
                "running": False, "phase": "error",
                "error": str(e), "message": f"Sync failed: {e}",
            })


@app.post("/strava/sync")
def strava_sync(range: str = Form("Since last sync")) -> dict:
    """Kick off a sync in a background thread. Returns immediately; poll
    `/strava/sync/status` for progress."""
    with _sync_lock:
        if _sync_state["running"]:
            return {"status": "already_running"}
        _sync_state.update({
            "running": True, "phase": "listing",
            "processed": 0, "total": 0, "inserted": 0, "skipped": 0,
            "message": "Starting…", "error": None,
        })

    cfg = ingest_strava.load_config()
    tokens = ingest_strava.load_tokens()
    if not tokens or not cfg.get("client_id"):
        with _sync_lock:
            _sync_state.update({"running": False, "phase": "error", "error": "Not authorised yet"})
        raise HTTPException(400, "Not authorised yet")
    tokens = ingest_strava.refresh_tokens(cfg["client_id"], cfg["client_secret"], tokens)
    since = _range_to_epoch(range)

    threading.Thread(target=_run_sync_thread, args=(tokens, since), daemon=True).start()
    return {"status": "started"}


@app.get("/strava/sync/status")
def strava_sync_status() -> dict:
    with _sync_lock:
        return dict(_sync_state)


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


@app.post("/strava/fix-types")
def strava_fix_types() -> dict:
    """Backfill the `type` column from Strava's `sport_type`. Cheap — only
    paginated summary calls (no streams), so a full backfill takes ~9 API
    calls for ~1700 activities."""
    import httpx as _hx
    cfg = ingest_strava.load_config()
    tokens = ingest_strava.load_tokens()
    if not tokens or not cfg.get("client_id"):
        raise HTTPException(400, "Not authorised yet")
    tokens = ingest_strava.refresh_tokens(cfg["client_id"], cfg["client_secret"], tokens)

    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    updated = 0
    examined = 0
    with _hx.Client(headers=headers, timeout=30) as client:
        page = 1
        while True:
            r = client.get(
                f"{ingest_strava.API}/athlete/activities",
                params={"per_page": 200, "page": page, "after": 0},
            )
            if r.status_code == 429:
                raise HTTPException(429, "Strava rate limit hit")
            r.raise_for_status()
            chunk = r.json()
            if not chunk:
                break
            for a in chunk:
                examined += 1
                t = ingest_strava._activity_type(a)
                if t not in ingest_strava.RUN_TYPES:
                    continue
                row = _db_fetchone("SELECT type FROM activities WHERE id = ?", [int(a["id"])])
                if row is None:
                    continue
                if row[0] != t:
                    _db_exec("UPDATE activities SET type = ? WHERE id = ?", [t, int(a["id"])])
                    updated += 1
            page += 1
    _invalidate_tracks_cache()
    return {"examined": examined, "updated": updated}


@app.delete("/strava/tokens")
def strava_forget_tokens() -> dict:
    ingest_strava.TOKEN_FILE.unlink(missing_ok=True)
    return {"ok": True}
