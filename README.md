# run-map

Personal local tool — pulls runs from Strava, renders them on a map, click any point to see the runs whose track passed over it.

## Quick start

```bash
uv venv && source .venv/bin/activate
uv pip install -e .

# One-time bulk import from a Strava data export
python -m run_map.ingest_bulk /path/to/strava_export/

# Or sync new activities from the Strava API
python -m run_map.ingest_strava

# Run the app
streamlit run src/run_map/app.py
```

## Strava API credentials

Create an API application at https://www.strava.com/settings/api and set:

```bash
export STRAVA_CLIENT_ID=...
export STRAVA_CLIENT_SECRET=...
```

Tokens are cached locally in `.strava_tokens.json`.
