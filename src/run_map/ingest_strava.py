"""Incremental Strava sync.

Can be driven from the UI (functions exchange_code / sync_with_tokens) or
from the CLI: `python -m run_map.ingest_strava` for the paste-code flow.
"""

from __future__ import annotations

import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import httpx

from . import db
from .activity_types import IMPORT_TYPES, canonical_type
from .parsers import points_to_linestring_wkt


class DailyRateLimit(Exception):
    """Raised when the Strava daily quota is exhausted — try again after the next UTC midnight."""

TOKEN_FILE = Path(".strava_tokens.json")
CONFIG_FILE = Path(".strava_config.json")
API = "https://www.strava.com/api/v3"


def _activity_type(a: dict) -> str:
    """Strava's legacy `type` collapses TrailRun into 'Run'. The newer
    `sport_type` field preserves the distinction — prefer it when present."""
    return a.get("sport_type") or a.get("type") or ""


def _gear_names(athlete_json: dict) -> dict[str, str]:
    """gear_id -> display name, from the athlete's shoes + bikes lists.
    Distinct Strava gear with identical names collapses later by design —
    the bulk export only carries names, so names are the canonical key."""
    out: dict[str, str] = {}
    for item in (athlete_json.get("shoes") or []) + (athlete_json.get("bikes") or []):
        gid = item.get("id")
        name = (item.get("name") or "").strip()
        if gid and name:
            out[gid] = name
    return out


def _enrichment_from_summary(a: dict, gear_names: dict[str, str]) -> dict:
    """upsert_activity enrichment kwargs available from a summary activity.
    description/weather are NOT in the summary payload — they stay None here
    and COALESCE in the upsert preserves any bulk-imported value."""
    def _f(key: str) -> float | None:
        v = a.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None
    return {
        "gear": gear_names.get(a.get("gear_id") or ""),
        "elevation_gain_m": _f("total_elevation_gain"),
        "avg_hr": _f("average_heartrate"),
        "max_hr": _f("max_heartrate"),
        "relative_effort": _f("suffer_score"),
    }


# ---- credentials / tokens -------------------------------------------------

def load_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


def save_config(client_id: str, client_secret: str) -> None:
    CONFIG_FILE.write_text(json.dumps({"client_id": client_id, "client_secret": client_secret}, indent=2))


def load_tokens() -> dict | None:
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text())
    return None


def save_tokens(tokens: dict) -> None:
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2))


def authorize_url(client_id: str) -> str:
    return (
        "https://www.strava.com/oauth/authorize?"
        f"client_id={client_id}&response_type=code&redirect_uri=http://localhost"
        "&approval_prompt=auto&scope=activity:read_all"
    )


def exchange_code(client_id: str, client_secret: str, code: str) -> dict:
    r = httpx.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    r.raise_for_status()
    tokens = r.json()
    save_tokens(tokens)
    return tokens


def refresh_tokens(client_id: str, client_secret: str, tokens: dict) -> dict:
    if tokens.get("expires_at", 0) > time.time() + 60:
        return tokens
    r = httpx.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=30,
    )
    r.raise_for_status()
    new_tokens = r.json()
    save_tokens(new_tokens)
    return new_tokens


# ---- sync -----------------------------------------------------------------

def _seconds_until_next_quarter() -> int:
    now = datetime.now(timezone.utc)
    # Strava's short-term window rolls every quarter hour (00, 15, 30, 45 UTC).
    minute = (now.minute // 15 + 1) * 15
    next_window = now.replace(minute=0, second=0, microsecond=0).timestamp() + minute * 60
    return max(1, int(next_window - now.timestamp()) + 2)


def _hit_daily_limit(resp: httpx.Response) -> bool:
    usage = resp.headers.get("X-RateLimit-Usage", "")
    limit = resp.headers.get("X-RateLimit-Limit", "")
    try:
        short_used, daily_used = (int(x) for x in usage.split(","))
        short_lim, daily_lim = (int(x) for x in limit.split(","))
    except ValueError:
        return False
    if daily_used >= daily_lim:
        return True
    return False


def _get_with_retry(client: httpx.Client, url: str, *, params: dict | None = None, on_wait=None) -> httpx.Response:
    """GET with one 429 retry that sleeps until the next 15-min window."""
    for attempt in (0, 1):
        r = client.get(url, params=params)
        if r.status_code != 429:
            return r
        if _hit_daily_limit(r):
            raise DailyRateLimit("Strava daily rate limit hit — try again after the next UTC midnight.")
        if attempt == 1:
            return r
        wait_s = _seconds_until_next_quarter()
        if on_wait:
            on_wait(wait_s)
        time.sleep(wait_s)
    return r  # unreachable


def _list_activities(client: httpx.Client, after_epoch: int, on_wait=None) -> list[dict]:
    activities: list[dict] = []
    page = 1
    while True:
        r = _get_with_retry(
            client,
            f"{API}/athlete/activities",
            params={"after": after_epoch, "per_page": 100, "page": page},
            on_wait=on_wait,
        )
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        activities.extend(chunk)
        page += 1
    return activities


def _get_latlng_stream(client: httpx.Client, activity_id: int, on_wait=None) -> list[tuple[float, float]] | None:
    r = _get_with_retry(
        client,
        f"{API}/activities/{activity_id}/streams",
        params={"keys": "latlng", "key_by_type": "true"},
        on_wait=on_wait,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    data = r.json()
    latlng = data.get("latlng", {}).get("data")
    if not latlng:
        return None
    return [(float(lat), float(lon)) for lat, lon in latlng]


def athlete(tokens: dict) -> dict:
    """Fetch the authenticated athlete profile — used as a credential health check."""
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    with httpx.Client(headers=headers, timeout=15) as client:
        r = client.get(f"{API}/athlete")
        r.raise_for_status()
        return r.json()


def sync_with_tokens(
    tokens: dict,
    *,
    since_epoch: int | None = None,
    on_wait=None,
    on_progress=None,
) -> tuple[int, int]:
    """Sync activities.

    `since_epoch` overrides the default (resume from `max(start_time)`).
    `on_wait(seconds)` fires when sleeping for a rate-limit window.
    `on_progress(state)` fires after each activity processed, with a dict:
        { phase, fetched, total, inserted, skipped, message }
    """
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    conn = db.connect()
    try:
        if since_epoch is not None:
            after_epoch = int(since_epoch)
        else:
            last = db.max_start_time(conn)
            after_epoch = int(last.replace(tzinfo=timezone.utc).timestamp()) if last else 0

        inserted = 0
        skipped = 0

        def _report(phase: str, processed: int, total: int, message: str = "") -> None:
            if on_progress:
                on_progress({
                    "phase": phase, "processed": processed, "total": total,
                    "inserted": inserted, "skipped": skipped, "message": message,
                })

        _report("listing", 0, 0, "Listing activities…")
        with httpx.Client(headers=headers, timeout=30) as client:
            activities = _list_activities(client, after_epoch, on_wait=on_wait)
            total = len(activities)
            _report("processing", 0, total, f"Found {total} activities to consider")

            # One /athlete call resolves every gear_id to its display name.
            # Failure here must not abort the sync — gear just stays NULL.
            gear_names: dict[str, str] = {}
            try:
                ar = _get_with_retry(client, f"{API}/athlete", on_wait=on_wait)
                ar.raise_for_status()
                gear_names = _gear_names(ar.json())
            except DailyRateLimit:
                raise
            except Exception:
                pass

            for i, a in enumerate(activities, start=1):
                raw_type = _activity_type(a)
                a_type = canonical_type(raw_type)
                # Type gate uses the summary payload only, so a rejected
                # activity never costs a stream API call. Distance is NOT
                # gated here — the hike threshold is applied at serve time.
                if raw_type not in IMPORT_TYPES:
                    skipped += 1
                    _report("processing", i, total)
                    continue
                # One malformed activity (bad geometry, odd payload) must not
                # abort a multi-thousand-activity sync — skip it and carry
                # on. Rate limits and fatal DB errors still propagate: the
                # first pauses the sync, and after the second nothing can
                # continue anyway.
                try:
                    stream = _get_latlng_stream(client, a["id"], on_wait=on_wait)
                    if not stream:
                        skipped += 1
                        _report("processing", i, total)
                        continue
                    wkt = points_to_linestring_wkt(stream)
                    if not wkt:
                        skipped += 1
                        _report("processing", i, total)
                        continue
                    start_time = datetime.fromisoformat(a["start_date"].replace("Z", "+00:00")).replace(tzinfo=None)
                    db.upsert_activity(
                        conn,
                        id=int(a["id"]),
                        start_time=start_time,
                        name=a.get("name") or "",
                        distance_m=float(a.get("distance") or 0.0),
                        moving_time_s=int(a.get("moving_time") or 0),
                        type=a_type,
                        strava_url=f"https://www.strava.com/activities/{a['id']}",
                        source="api",
                        track_wkt=wkt,
                        **_enrichment_from_summary(a, gear_names),
                    )
                    inserted += 1
                except (DailyRateLimit, duckdb.FatalException):
                    raise
                except Exception:
                    skipped += 1
                _report("processing", i, total)
    finally:
        conn.close()
    return inserted, skipped


# ---- CLI ------------------------------------------------------------------

def _cli_creds() -> tuple[str, str]:
    cid = os.environ.get("STRAVA_CLIENT_ID")
    secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not cid or not secret:
        cfg = load_config()
        cid = cid or cfg.get("client_id")
        secret = secret or cfg.get("client_secret")
    if not cid or not secret:
        raise SystemExit("Set STRAVA_CLIENT_ID/SECRET or configure them in the UI first.")
    return cid, secret


def main(argv: list[str] | None = None) -> int:
    cid, secret = _cli_creds()
    tokens = load_tokens()
    if not tokens:
        url = authorize_url(cid)
        print("Open this URL, approve, paste the 'code' from the redirected URL:")
        print(url)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        code = input("code: ").strip()
        tokens = exchange_code(cid, secret, code)
    else:
        tokens = refresh_tokens(cid, secret, tokens)

    def on_wait(seconds: int) -> None:
        print(f"[rate-limit] waiting {seconds}s for next Strava window…")

    try:
        inserted, skipped = sync_with_tokens(tokens, on_wait=on_wait)
    except DailyRateLimit as e:
        print(str(e))
        return 2
    print(f"Synced {inserted} new runs (skipped {skipped})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
