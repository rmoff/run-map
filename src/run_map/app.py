"""Streamlit app — click any point on the map to see when you've run there before."""

from __future__ import annotations

import json

import folium
import streamlit as st
from folium.plugins import Draw
from streamlit_folium import st_folium

from . import db

st.set_page_config(page_title="run-map", layout="wide")


@st.cache_resource
def get_conn():
    return db.connect()


@st.cache_data(ttl=60)
def fetch_all_tracks(type_filter: tuple[str, ...]) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, start_time, name, distance_m, strava_url, ST_AsGeoJSON(track) AS geo
        FROM activities
        WHERE type = ANY(?)
        """,
        [list(type_filter)],
    ).fetchall()
    return [
        {
            "id": r[0],
            "start_time": r[1],
            "name": r[2],
            "distance_m": r[3],
            "strava_url": r[4],
            "geo": json.loads(r[5]) if r[5] else None,
        }
        for r in rows
        if r[5]
    ]


@st.cache_data(ttl=60)
def all_types() -> list[str]:
    conn = get_conn()
    rows = conn.execute("SELECT DISTINCT type FROM activities ORDER BY 1").fetchall()
    return [r[0] for r in rows]


def query_point(lat: float, lon: float, radius_deg: float, types: list[str]) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, start_time, name, distance_m, strava_url
        FROM activities
        WHERE type = ANY(?)
          AND ST_DWithin(track, ST_Point(?, ?), ?)
        ORDER BY start_time DESC
        """,
        [types, lon, lat, radius_deg],
    ).fetchall()
    return [
        {"id": r[0], "start_time": r[1], "name": r[2], "distance_m": r[3], "strava_url": r[4]}
        for r in rows
    ]


def query_polygon(polygon_wkt: str, types: list[str]) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, start_time, name, distance_m, strava_url
        FROM activities
        WHERE type = ANY(?)
          AND ST_Intersects(track, ST_GeomFromText(?))
        ORDER BY start_time DESC
        """,
        [types, polygon_wkt],
    ).fetchall()
    return [
        {"id": r[0], "start_time": r[1], "name": r[2], "distance_m": r[3], "strava_url": r[4]}
        for r in rows
    ]


def _geojson_to_wkt(geom: dict) -> str:
    """Convert a GeoJSON Polygon (from Leaflet.draw) to WKT."""
    coords = geom["coordinates"][0]
    pts = ", ".join(f"{x} {y}" for x, y in coords)
    return f"POLYGON(({pts}))"


# ---- UI -------------------------------------------------------------------

st.title("run-map")

types_available = all_types()
if not types_available:
    st.info("No activities yet. Run `python -m run_map.ingest_bulk <export_dir>` first.")
    st.stop()

with st.sidebar:
    st.header("Filters")
    default_types = [t for t in ("Run", "TrailRun") if t in types_available] or types_available
    selected_types = st.multiselect("Activity types", types_available, default=default_types)
    radius_deg = st.slider(
        "Click radius (degrees)",
        min_value=0.00005,
        max_value=0.005,
        value=0.0003,
        step=0.00005,
        format="%.5f",
        help="~0.0001° ≈ 11 m at the equator. Tune to taste.",
    )

if not selected_types:
    st.warning("Pick at least one activity type.")
    st.stop()

tracks = fetch_all_tracks(tuple(selected_types))
if not tracks:
    st.info("No activities match the current filters.")
    st.stop()

# Centre on the bounding box of all tracks
all_coords = [pt for t in tracks for pt in t["geo"]["coordinates"]]
lons = [c[0] for c in all_coords]
lats = [c[1] for c in all_coords]
centre = [(min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2]

m = folium.Map(location=centre, zoom_start=12, tiles="cartodbpositron")
m.fit_bounds([[min(lats), min(lons)], [max(lats), max(lons)]])

# Single GeoJSON layer for performance
features = [
    {"type": "Feature", "geometry": t["geo"], "properties": {"id": t["id"]}} for t in tracks
]
folium.GeoJson(
    {"type": "FeatureCollection", "features": features},
    style_function=lambda _: {"color": "#1f77b4", "weight": 1.5, "opacity": 0.35},
).add_to(m)

# Highlight previous matches on top of the base layer
if "matches" in st.session_state and st.session_state["matches"]:
    match_ids = {r["id"] for r in st.session_state["matches"]}
    highlight = [f for f in features if f["properties"]["id"] in match_ids]
    folium.GeoJson(
        {"type": "FeatureCollection", "features": highlight},
        style_function=lambda _: {"color": "#d62728", "weight": 4, "opacity": 0.9},
    ).add_to(m)

# Show the last clicked point as a marker
last_pt = st.session_state.get("last_point")
if last_pt:
    folium.CircleMarker(
        location=[last_pt["lat"], last_pt["lng"]],
        radius=6,
        color="#d62728",
        fill=True,
        fill_opacity=0.8,
    ).add_to(m)

Draw(
    export=False,
    draw_options={
        "polyline": False, "circle": False, "marker": False, "circlemarker": False,
        "polygon": True, "rectangle": True,
    },
    edit_options={"edit": False},
).add_to(m)

map_state = st_folium(m, height=720, use_container_width=True, returned_objects=["last_clicked", "last_active_drawing"])

# ---- Handle interactions --------------------------------------------------

new_query = False

last_drawing = map_state.get("last_active_drawing") if map_state else None
if last_drawing and last_drawing.get("geometry", {}).get("type") in ("Polygon",):
    wkt = _geojson_to_wkt(last_drawing["geometry"])
    if st.session_state.get("last_polygon_wkt") != wkt:
        st.session_state["last_polygon_wkt"] = wkt
        st.session_state["last_point"] = None
        st.session_state["matches"] = query_polygon(wkt, selected_types)
        new_query = True

last_clicked = map_state.get("last_clicked") if map_state else None
if last_clicked and not new_query:
    pt_key = (last_clicked["lat"], last_clicked["lng"], radius_deg, tuple(selected_types))
    if st.session_state.get("last_query_key") != pt_key:
        st.session_state["last_query_key"] = pt_key
        st.session_state["last_point"] = last_clicked
        st.session_state["last_polygon_wkt"] = None
        st.session_state["matches"] = query_point(
            last_clicked["lat"], last_clicked["lng"], radius_deg, selected_types
        )
        new_query = True

# Re-run the previous query if the radius changed
if (
    not new_query
    and st.session_state.get("last_point")
    and st.session_state.get("last_query_key")
    and st.session_state["last_query_key"][2] != radius_deg
):
    pt = st.session_state["last_point"]
    st.session_state["last_query_key"] = (pt["lat"], pt["lng"], radius_deg, tuple(selected_types))
    st.session_state["matches"] = query_point(pt["lat"], pt["lng"], radius_deg, selected_types)
    new_query = True

if new_query:
    st.rerun()

# ---- Results panel --------------------------------------------------------

matches = st.session_state.get("matches") or []
with st.sidebar:
    st.header(f"Matches ({len(matches)})")
    if not matches:
        st.caption("Click a point on the map, or draw a polygon.")
    for r in matches:
        date = r["start_time"].strftime("%Y-%m-%d") if r["start_time"] else "?"
        km = (r["distance_m"] or 0) / 1000.0
        name = r["name"] or "(unnamed)"
        st.markdown(f"**{date}** — [{name}]({r['strava_url']}) · {km:.1f} km")
