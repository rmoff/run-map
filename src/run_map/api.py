"""FastAPI backend — serves the Leaflet UI and the spatial query endpoints."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
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

from . import activity_types, db, ingest_bulk, ingest_strava

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


# ---- Filters --------------------------------------------------------------
#
# The map endpoints share a small set of attribute filters: which years to
# include, which run type, distance window. They translate to one shared
# WHERE clause. `_filter_clause` returns both the SQL fragment and a stable
# signature dict — the dict feeds the on-disk cache key.


def _parse_iso_date(s: str, field: str) -> str:
    # Returns the ISO date string after validation. Throws 400 on bad input.
    try:
        datetime.fromisoformat(s).date()
    except ValueError:
        raise HTTPException(400, f"Invalid {field} (expected YYYY-MM-DD): {s!r}")
    return s


def _filter_clause(
    date_start: str | None = None,
    date_end: str | None = None,
    type: str | None = None,
    min_km: float | None = None,
    max_km: float | None = None,
) -> tuple[list[str], list, dict]:
    where: list[str] = []
    params: list = []
    sig: dict = {}
    if date_start:
        ds = _parse_iso_date(date_start, "date_start")
        where.append("start_time::DATE >= ?")
        params.append(ds)
        sig["date_start"] = ds
    if date_end:
        de = _parse_iso_date(date_end, "date_end")
        where.append("start_time::DATE <= ?")
        params.append(de)
        sig["date_end"] = de
    if type:
        # Comma-separated list ("two of three pills on"). Sorted so param
        # order can't change the WHERE clause or the cache sig; a lone value
        # keeps the exact sig it had before multi-type existed, so old cache
        # entries stay valid.
        types = sorted({t.strip() for t in type.split(",") if t.strip()})
        if len(types) == 1:
            where.append("type = ?")
            params.append(types[0])
            sig["type"] = types[0]
        elif types:
            where.append("type IN (" + ", ".join("?" * len(types)) + ")")
            params.extend(types)
            sig["type"] = types
    if min_km is not None:
        where.append("distance_m >= ?")
        params.append(min_km * 1000.0)
        sig["min_km"] = min_km
    if max_km is not None:
        where.append("distance_m < ?")
        params.append(max_km * 1000.0)
        sig["max_km"] = max_km
    return where, params, sig


# ---- Disk cache -----------------------------------------------------------
#
# Boot blobs (/index.json, /aggregate.geojson, /heatmap.json) are expensive
# to build and don't change between ingests, so we gzip them to
# `<RUN_MAP_DB parent>/cache/<sig>.gz` and serve via `FileResponse` — which
# uses sendfile, so Python never touches the bytes on the hot path.
#
# Filter combinations produce additional cache entries; the unfiltered case
# is the common one. `_invalidate_caches()` clears the whole dir.

_CACHE_DIR = db.DB_PATH.parent / "cache"


def _cache_sig(name: str, sig: dict) -> str:
    if not sig:
        return name
    h = hashlib.sha1(json.dumps(sig, sort_keys=True).encode()).hexdigest()[:10]
    return f"{name}.{h}"


def _cache_path(sig_str: str) -> Path:
    _CACHE_DIR.mkdir(exist_ok=True)
    return _CACHE_DIR / f"{sig_str}.json.gz"


def _serve_cached(sig_str: str, build: callable) -> Response:
    p = _cache_path(sig_str)
    if not p.exists():
        body = build()
        p.write_bytes(gzip.compress(body, compresslevel=6))
    return FileResponse(
        p,
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"},
    )


def _invalidate_caches() -> None:
    if _CACHE_DIR.exists():
        for p in _CACHE_DIR.glob("*.json.gz"):
            try:
                p.unlink()
            except OSError:
                pass


# Back-compat alias — kept so any external imports don't break.
_invalidate_tracks_cache = _invalidate_caches  # back-compat


def _warm_default_aggregates() -> None:
    """Pre-build the no-filter aggregate at every LOD so first paint after an
    ingest is cache-warm. Filtered combos stay lazy.

    Defined above `_build_aggregate` and `_cache_sig` users only by file
    position; both symbols resolve at call time.
    """
    for lod in _AGG_LODS:
        sig = _cache_sig("aggregate", {"lod": lod})
        p = _cache_path(sig)
        if p.exists():
            continue
        body = _build_aggregate(lod=lod)
        p.write_bytes(gzip.compress(body, compresslevel=6))


# ---- Queries --------------------------------------------------------------


def _geometry_to_latlngs(geojson_str: str | None) -> list[list[float]]:
    """Convert a GeoJSON LineString / MultiLineString to a flat list of [lat,
    lng] pairs. MultiLineString segments are concatenated — the rendering side
    treats each match as a single polyline, which is what the existing UI
    expects."""
    if not geojson_str:
        return []
    g = json.loads(geojson_str)
    t = g.get("type")
    coords = g.get("coordinates") or []
    if t == "LineString":
        return [[c[1], c[0]] for c in coords]
    if t == "MultiLineString":
        out: list[list[float]] = []
        for line in coords:
            out.extend([c[1], c[0]] for c in line)
        return out
    return []


def _match_rows(rows) -> list[dict]:
    out = []
    for r in rows:
        out.append({
            "id": r[0],
            "start_time": r[1].isoformat() if r[1] else None,
            "name": r[2],
            "distance_m": r[3],
            "strava_url": r[4],
            "activity_type": r[5] if len(r) > 5 else None,
            "geometry": _geometry_to_latlngs(r[6]) if len(r) > 6 else [],
        })
    return out


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
               SUM(CASE WHEN type = 'Hike' THEN 1 ELSE 0 END) AS hike,
               SUM(CASE WHEN type NOT IN ('TrailRun', 'Hike') THEN 1 ELSE 0 END) AS road
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
            {"year": int(y), "trail": int(t or 0), "hike": int(h or 0), "road": int(r or 0)}
            for y, t, h, r in yearly
        ],
    }


# Tolerance for ST_Simplify on match geometries — ~1m at the equator. Tracks
# get smaller without visible loss, and the precise red match polylines stay
# crisp at zoom 18.
_MATCH_SIMPLIFY_TOL = 1e-5


@app.get("/match")
def match_point(
    lat: float, lon: float, r: float,
    date_start: str | None = None, date_end: str | None = None,
    type: str | None = None,
    min_km: float | None = None, max_km: float | None = None,
) -> list[dict]:
    """Runs whose track came within `r` metres of (lat, lon). Each match
    carries its simplified polyline so the client can render the precise
    track without having loaded the bulk track set."""
    radius_deg = r / 111_000.0
    where = ["ST_DWithin(track, ST_Point(?, ?), ?)"]
    params: list = [lon, lat, radius_deg]
    fwhere, fparams, _ = _filter_clause(date_start, date_end, type, min_km, max_km)
    where.extend(fwhere)
    params.extend(fparams)
    sql = (
        "SELECT id, start_time, name, distance_m, strava_url, type, "
        "       ST_AsGeoJSON(ST_Simplify(track, ?)) "
        "FROM activities WHERE " + " AND ".join(where) + " ORDER BY start_time DESC"
    )
    rows = _db_fetchall(sql, [_MATCH_SIMPLIFY_TOL] + params)
    return _match_rows(rows)


@app.post("/match/polygon")
def match_polygon(
    wkt: str = Form(...),
    date_start: str | None = Form(None),
    date_end: str | None = Form(None),
    type: str | None = Form(None),
    min_km: float | None = Form(None),
    max_km: float | None = Form(None),
) -> list[dict]:
    where = ["ST_Intersects(track, ST_GeomFromText(?))"]
    params: list = [wkt]
    fwhere, fparams, _ = _filter_clause(date_start, date_end, type, min_km, max_km)
    where.extend(fwhere)
    params.extend(fparams)
    sql = (
        "SELECT id, start_time, name, distance_m, strava_url, type, "
        "       ST_AsGeoJSON(ST_Simplify(track, ?)) "
        "FROM activities WHERE " + " AND ".join(where) + " ORDER BY start_time DESC"
    )
    rows = _db_fetchall(sql, [_MATCH_SIMPLIFY_TOL] + params)
    return _match_rows(rows)


# ---- Aggregate path layer + per-activity index + heatmap -----------------

# Snap grids for aggregate dedupe, keyed by zoom band. Each LOD is a separate
# pre-built layer the client swaps to on `zoomend`:
#   low  (~50 m)  for z 11–13 — neighbourhood overview, streets blur anyway
#   mid  (~33 m)  for z 14–15 — historic default, balances drift vs distinctness
#   high (~10 m)  for z 16+   — individual paths through fields / woods, also
#                               the LOD the client always uses for snap-to-track
# Server owns the band names; client sends `?lod=<name>`. Grids are degrees of
# latitude (rough metres at this latitude in the comment above each).
_AGG_LODS: dict[str, float] = {"low": 4.5e-4, "mid": 3e-4, "high": 9e-5}
_AGG_LOD_DEFAULT = "mid"
# Back-compat alias for any caller that still wants the historical fixed grid.
_AGG_GRID = _AGG_LODS[_AGG_LOD_DEFAULT]
# Coarse samples per track in /index.json — feeds hex aggregation + view-fit
# + auto-match. Eight points is plenty for those uses.
_INDEX_SAMPLES = 8
# Step (in vertices, not metres) for the heatmap sample. Most tracks log at
# 1 Hz and ~4 m/s, so every 8th vertex ≈ every 30 m on real ground — well
# inside the Gaussian kernel reach, so the heatmap paints a continuous line
# along the route rather than discrete pulses.
_HEATMAP_STEP = 8


def _coords_from_geojson(geojson_str: str) -> list[list[float]]:
    """Return [[lon, lat], ...]. Flatten MultiLineString."""
    g = json.loads(geojson_str)
    t = g.get("type")
    coords = g.get("coordinates") or []
    if t == "LineString":
        return coords
    if t == "MultiLineString":
        out: list[list[float]] = []
        for line in coords:
            out.extend(line)
        return out
    return []


def _filtered_rows(cols: str, **filters) -> list:
    where, params, _ = _filter_clause(**filters)
    sql = f"SELECT {cols} FROM activities"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return _db_fetchall(sql, params)


def _build_index(**filters) -> bytes:
    rows = _filtered_rows(
        "id, start_time, type, distance_m, ST_AsGeoJSON(track)", **filters
    )
    entries = []
    for r in rows:
        coords = _coords_from_geojson(r[4]) if r[4] else []
        if not coords:
            continue
        step = max(1, len(coords) // _INDEX_SAMPLES)
        samples = [[coords[i][1], coords[i][0]] for i in range(0, len(coords), step)]
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
        entries.append({
            "id": r[0],
            "start_time": r[1].isoformat() if r[1] else None,
            "type": r[2],
            "distance_m": r[3],
            "samples": samples,
            "bbox": [min(lons), min(lats), max(lons), max(lats)],
        })
    return json.dumps({"activities": entries}).encode()


def _build_aggregate(*, lod: str = _AGG_LOD_DEFAULT, **filters) -> bytes:
    """Snap-to-grid + dedupe segments across every track.

    Each consecutive `(a, b)` pair in a track is snapped to the `_AGG_LODS[lod]`
    cell and normalised so `(a, b)` and `(b, a)` collide into the same key.
    No upstream simplification: Douglas-Peucker would pick different
    "important" vertices per track and produce ghost segments where two runs
    followed the same road — the dense, snap-to-cells walk dedupes properly.
    """
    rows = _filtered_rows("ST_AsGeoJSON(track)", **filters)
    grid = _AGG_LODS[lod]
    seen: set = set()
    segments: list[list[list[float]]] = []
    for (gj,) in rows:
        if not gj:
            continue
        prev = None
        for c in _coords_from_geojson(gj):
            snapped = (round(c[0] / grid) * grid, round(c[1] / grid) * grid)
            if prev is None:
                prev = snapped
                continue
            if snapped == prev:
                continue
            key = (prev, snapped) if prev < snapped else (snapped, prev)
            if key not in seen:
                seen.add(key)
                segments.append([[prev[0], prev[1]], [snapped[0], snapped[1]]])
            prev = snapped
    geometry = {"type": "MultiLineString", "coordinates": segments}
    feature = {"type": "Feature", "geometry": geometry, "properties": {
        "segment_count": len(segments),
    }}
    return json.dumps({"type": "FeatureCollection", "features": [feature]}).encode()


def _build_heatmap(**filters) -> bytes:
    """Dense per-track points for the heatmap. Step picked so the heatmap
    kernel sees an effectively continuous line along the route."""
    rows = _filtered_rows("ST_AsGeoJSON(track)", **filters)
    points: list[list[float]] = []
    step = _HEATMAP_STEP
    for (gj,) in rows:
        if not gj:
            continue
        coords = _coords_from_geojson(gj)
        for i in range(0, len(coords), step):
            points.append([coords[i][1], coords[i][0]])
    return json.dumps({"points": points}).encode()


@app.get("/index.json")
def activity_index(
    date_start: str | None = None, date_end: str | None = None,
    type: str | None = None,
    min_km: float | None = None, max_km: float | None = None,
) -> Response:
    _, _, sig = _filter_clause(date_start, date_end, type, min_km, max_km)
    return _serve_cached(
        _cache_sig("index", sig),
        lambda: _build_index(date_start=date_start, date_end=date_end,
                             type=type, min_km=min_km, max_km=max_km),
    )


@app.get("/aggregate.geojson")
def aggregate_geojson(
    date_start: str | None = None, date_end: str | None = None,
    type: str | None = None,
    min_km: float | None = None, max_km: float | None = None,
    lod: str = _AGG_LOD_DEFAULT,
) -> Response:
    if lod not in _AGG_LODS:
        raise HTTPException(400, f"Unknown lod '{lod}'. Expected one of: {sorted(_AGG_LODS)}")
    _, _, sig = _filter_clause(date_start, date_end, type, min_km, max_km)
    sig = {**sig, "lod": lod}
    return _serve_cached(
        _cache_sig("aggregate", sig),
        lambda: _build_aggregate(lod=lod, date_start=date_start, date_end=date_end,
                                  type=type, min_km=min_km, max_km=max_km),
    )


@app.get("/heatmap.json")
def heatmap_json(
    date_start: str | None = None, date_end: str | None = None,
    type: str | None = None,
    min_km: float | None = None, max_km: float | None = None,
) -> Response:
    _, _, sig = _filter_clause(date_start, date_end, type, min_km, max_km)
    return _serve_cached(
        _cache_sig("heatmap", sig),
        lambda: _build_heatmap(date_start=date_start, date_end=date_end,
                               type=type, min_km=min_km, max_km=max_km),
    )


@app.get("/filter-options")
def filter_options() -> dict:
    """Date range + types present in the library — feeds the filter chip menu."""
    row = _db_fetchone(
        "SELECT MIN(start_time::DATE), MAX(start_time::DATE) "
        "FROM activities WHERE start_time IS NOT NULL"
    )
    min_date = row[0].isoformat() if row and row[0] else None
    max_date = row[1].isoformat() if row and row[1] else None
    types = [t for (t,) in _db_fetchall(
        "SELECT DISTINCT type FROM activities WHERE type IS NOT NULL ORDER BY 1"
    )]
    return {"min_date": min_date, "max_date": max_date, "types": types}


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
        _invalidate_caches()
        _warm_default_aggregates()
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
        _invalidate_caches()
        _warm_default_aggregates()
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
    """Backfill the `type` column from Strava's `sport_type` (Walk stored
    as its canonical "Hike"). Only UPDATEs rows already in the DB — it never
    imports new activities. Cheap — only paginated summary calls (no
    streams), so a full backfill takes ~9 API calls for ~1700 activities."""
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
                raw = ingest_strava._activity_type(a)
                if raw not in activity_types.IMPORT_TYPES:
                    continue
                t = activity_types.canonical_type(raw)
                row = _db_fetchone("SELECT type FROM activities WHERE id = ?", [int(a["id"])])
                if row is None:
                    continue
                if row[0] != t:
                    _db_exec("UPDATE activities SET type = ? WHERE id = ?", [t, int(a["id"])])
                    updated += 1
            page += 1
    _invalidate_caches()
    _warm_default_aggregates()
    return {"examined": examined, "updated": updated}


@app.delete("/strava/tokens")
def strava_forget_tokens() -> dict:
    ingest_strava.TOKEN_FILE.unlink(missing_ok=True)
    return {"ok": True}
