"""Bulk import from an unzipped Strava data export.

Usage:
    python -m run_map.ingest_bulk /path/to/strava_export/
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

from . import db
from .activity_types import IMPORT_TYPES, canonical_type
from .parsers import parse_track_file


def _find_track_file(export_dir: Path, rel_path: str) -> Path | None:
    """Strava export's activities.csv has a 'Filename' column like 'activities/123.fit.gz'."""
    if not rel_path:
        return None
    p = (export_dir / rel_path).resolve()
    if p.exists():
        return p
    # Some exports have just the basename
    candidate = export_dir / "activities" / Path(rel_path).name
    if candidate.exists():
        return candidate
    return None


def _parse_csv(export_dir: Path) -> pd.DataFrame:
    csv_path = export_dir / "activities.csv"
    if not csv_path.exists():
        # Must be a normal exception: SystemExit is silently swallowed by
        # worker threads, which would wedge the import UI at running=True.
        raise FileNotFoundError(f"activities.csv not found in {export_dir}")
    df = pd.read_csv(csv_path)
    # Strava uses different column names across export vintages — normalise the ones we need.
    rename = {}
    for col in df.columns:
        low = col.lower().strip()
        if low == "activity id":
            rename[col] = "id"
        elif low == "activity date":
            rename[col] = "start_time"
        elif low == "activity name":
            rename[col] = "name"
        elif low == "activity type":
            rename[col] = "type"
        elif low == "distance" and "distance_m" not in rename.values():
            rename[col] = "distance_km_or_m"
        elif low == "moving time":
            rename[col] = "moving_time_s"
        elif low == "filename":
            rename[col] = "filename"
    df = df.rename(columns=rename)
    return df


def ingest(export_dir: Path, *, progress_cb=None) -> tuple[int, int]:
    """Ingest runs from a Strava export directory.

    `progress_cb(done, total, label)` is called once per CSV row so the UI can
    drive a progress bar. `done` is the number of rows processed so far.
    """
    df = _parse_csv(export_dir)
    df = df[df["type"].isin(IMPORT_TYPES)].copy()

    total = len(df)
    inserted = 0
    skipped = 0
    conn = db.connect()
    try:
        for done, (_, row) in enumerate(df.iterrows(), start=1):
            if progress_cb is not None:
                progress_cb(done, total, str(row.get("name") or row.get("filename") or ""))
            # One malformed row/file must not abort the whole import — count
            # it and keep going.
            try:
                distance_raw = row.get("distance_km_or_m")
                try:
                    distance_m = float(distance_raw)
                    # Export historically stored km; if it looks like km, convert.
                    if distance_m < 1000:
                        distance_m *= 1000.0
                except (TypeError, ValueError):
                    distance_m = 0.0
                a_type = canonical_type(str(row["type"]))
                track_path = _find_track_file(export_dir, str(row.get("filename", "")))
                if not track_path:
                    skipped += 1
                    continue
                wkt = parse_track_file(track_path)
                if not wkt:
                    skipped += 1
                    continue

                activity_id = int(row["id"])
                start_time = pd.to_datetime(row["start_time"], utc=True).to_pydatetime().replace(tzinfo=None)
                try:
                    moving_time_s = int(row.get("moving_time_s"))
                except (TypeError, ValueError):
                    moving_time_s = 0

                db.upsert_activity(
                    conn,
                    id=activity_id,
                    start_time=start_time,
                    name=str(row.get("name") or ""),
                    distance_m=distance_m,
                    moving_time_s=moving_time_s,
                    type=a_type,
                    strava_url=f"https://www.strava.com/activities/{activity_id}",
                    source="bulk",
                    track_wkt=wkt,
                )
                inserted += 1
            except Exception:
                skipped += 1
    finally:
        conn.close()
    return inserted, skipped


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("export_dir", type=Path, help="Path to unzipped Strava export folder")
    args = ap.parse_args(argv)
    if not args.export_dir.is_dir():
        print(f"Not a directory: {args.export_dir}", file=sys.stderr)
        return 1
    started = datetime.now()
    try:
        inserted, skipped = ingest(args.export_dir)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"Ingested {inserted} activities (skipped {skipped}) in {datetime.now() - started}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
