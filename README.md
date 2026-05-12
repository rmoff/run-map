# run-map

Personal local tool — pulls runs from Strava, renders them on a map, click any point to see the runs whose track passed over it.

## Run with Docker (recommended)

```bash
mkdir -p data
docker compose up --build -d
# → http://localhost:8501  (also reachable on the LAN — Docker bypasses firewalld)
```

The `./data` folder is bind-mounted to `/data` inside the container, so `runs.duckdb`, `.strava_tokens.json`, and any Strava export you drop in there persist across restarts.

### Bulk import from a Strava export

```bash
# Unzip your Strava export into ./data/export
docker compose run --rm app python -m run_map.ingest_bulk /data/export
```

### Incremental sync from the Strava API

Create an API app at https://www.strava.com/settings/api, then:

```bash
export STRAVA_CLIENT_ID=...
export STRAVA_CLIENT_SECRET=...
docker compose run --rm -it app python -m run_map.ingest_strava
```

(The `-it` flag is needed once for the OAuth paste-code prompt; tokens are then cached in `./data/.strava_tokens.json` and future syncs are non-interactive.)

## Run natively

```bash
uv venv && source .venv/bin/activate
uv pip install -e .

python -m run_map.ingest_bulk /path/to/strava_export/
# or
python -m run_map.ingest_strava

streamlit run src/run_map/app.py
```
