"""Incremental Strava sync.

Usage:
    export STRAVA_CLIENT_ID=...
    export STRAVA_CLIENT_SECRET=...
    python -m run_map.ingest_strava
"""

from __future__ import annotations

import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import db
from .parsers import points_to_linestring_wkt

TOKEN_FILE = Path(".strava_tokens.json")
API = "https://www.strava.com/api/v3"
RUN_TYPES = {"Run", "TrailRun"}


def _load_tokens() -> dict | None:
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text())
    return None


def _save_tokens(tokens: dict) -> None:
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2))


def _client_creds() -> tuple[str, str]:
    cid = os.environ.get("STRAVA_CLIENT_ID")
    secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not cid or not secret:
        raise SystemExit("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET environment variables.")
    return cid, secret


def _authorise() -> dict:
    """Paste-code OAuth flow — single-user, no callback server."""
    cid, secret = _client_creds()
    auth_url = (
        "https://www.strava.com/oauth/authorize?"
        f"client_id={cid}&response_type=code&redirect_uri=http://localhost"
        "&approval_prompt=auto&scope=activity:read_all"
    )
    print("Open this URL, approve, then paste the 'code' query parameter from the redirected URL:")
    print(auth_url)
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass
    code = input("code: ").strip()
    r = httpx.post(
        "https://www.strava.com/oauth/token",
        data={"client_id": cid, "client_secret": secret, "code": code, "grant_type": "authorization_code"},
        timeout=30,
    )
    r.raise_for_status()
    tokens = r.json()
    _save_tokens(tokens)
    return tokens


def _refresh_if_needed(tokens: dict) -> dict:
    if tokens.get("expires_at", 0) > time.time() + 60:
        return tokens
    cid, secret = _client_creds()
    r = httpx.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": cid,
            "client_secret": secret,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=30,
    )
    r.raise_for_status()
    new_tokens = r.json()
    _save_tokens(new_tokens)
    return new_tokens


def _get_tokens() -> dict:
    tokens = _load_tokens()
    if not tokens:
        return _authorise()
    return _refresh_if_needed(tokens)


def _list_activities(client: httpx.Client, after_epoch: int) -> list[dict]:
    activities: list[dict] = []
    page = 1
    while True:
        r = client.get(f"{API}/athlete/activities", params={"after": after_epoch, "per_page": 100, "page": page})
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        activities.extend(chunk)
        page += 1
    return activities


def _get_latlng_stream(client: httpx.Client, activity_id: int) -> list[tuple[float, float]] | None:
    r = client.get(f"{API}/activities/{activity_id}/streams", params={"keys": "latlng", "key_by_type": "true"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    data = r.json()
    latlng = data.get("latlng", {}).get("data")
    if not latlng:
        return None
    return [(float(lat), float(lon)) for lat, lon in latlng]


def sync() -> tuple[int, int]:
    tokens = _get_tokens()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    conn = db.connect()
    try:
        last = db.max_start_time(conn)
        after_epoch = int(last.replace(tzinfo=timezone.utc).timestamp()) if last else 0

        inserted = 0
        skipped = 0
        with httpx.Client(headers=headers, timeout=30) as client:
            activities = _list_activities(client, after_epoch)
            for a in activities:
                if a.get("type") not in RUN_TYPES:
                    skipped += 1
                    continue
                stream = _get_latlng_stream(client, a["id"])
                if not stream:
                    skipped += 1
                    continue
                wkt = points_to_linestring_wkt(stream)
                if not wkt:
                    skipped += 1
                    continue
                start_time = datetime.fromisoformat(a["start_date"].replace("Z", "+00:00")).replace(tzinfo=None)
                db.upsert_activity(
                    conn,
                    id=int(a["id"]),
                    start_time=start_time,
                    name=a.get("name") or "",
                    distance_m=float(a.get("distance") or 0.0),
                    moving_time_s=int(a.get("moving_time") or 0),
                    type=a["type"],
                    strava_url=f"https://www.strava.com/activities/{a['id']}",
                    source="api",
                    track_wkt=wkt,
                )
                inserted += 1
    finally:
        conn.close()
    return inserted, skipped


def main(argv: list[str] | None = None) -> int:
    inserted, skipped = sync()
    print(f"Synced {inserted} new runs (skipped {skipped} non-runs/no-GPS)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
