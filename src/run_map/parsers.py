from __future__ import annotations

import gzip
from pathlib import Path

import fitdecode
import gpxpy
from shapely.geometry import LineString


def _to_linestring_wkt(points: list[tuple[float, float]]) -> str | None:
    if len(points) < 2:
        return None
    line = LineString([(lon, lat) for lat, lon in points])
    line = line.simplify(1e-5, preserve_topology=False)
    if line.is_empty or len(line.coords) < 2:
        return None
    return line.wkt


def _open_maybe_gz(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rb")
    return open(path, "rb")


def parse_gpx(path: Path) -> str | None:
    with _open_maybe_gz(path) as fh:
        gpx = gpxpy.parse(fh)
    points: list[tuple[float, float]] = []
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                points.append((p.latitude, p.longitude))
    return _to_linestring_wkt(points)


def _semicircles_to_deg(v: int) -> float:
    return v * (180.0 / 2**31)


def parse_fit(path: Path) -> str | None:
    points: list[tuple[float, float]] = []
    with _open_maybe_gz(path) as fh:
        with fitdecode.FitReader(fh) as reader:
            for frame in reader:
                if not isinstance(frame, fitdecode.FitDataMessage):
                    continue
                if frame.name != "record":
                    continue
                try:
                    lat_sc = frame.get_value("position_lat", fallback=None)
                    lon_sc = frame.get_value("position_long", fallback=None)
                except KeyError:
                    continue
                if lat_sc is None or lon_sc is None:
                    continue
                points.append((_semicircles_to_deg(lat_sc), _semicircles_to_deg(lon_sc)))
    return _to_linestring_wkt(points)


def parse_track_file(path: Path) -> str | None:
    name = path.name.lower()
    if name.endswith(".gpx") or name.endswith(".gpx.gz"):
        return parse_gpx(path)
    if name.endswith(".fit") or name.endswith(".fit.gz"):
        return parse_fit(path)
    return None


def points_to_linestring_wkt(latlng_points: list[tuple[float, float]]) -> str | None:
    return _to_linestring_wkt(latlng_points)
