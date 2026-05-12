FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir -e .

# Runtime working dir is the mounted data volume so runs.duckdb and
# .strava_tokens.json live alongside any imported Strava exports.
WORKDIR /data

EXPOSE 8501

CMD ["uvicorn", "run_map.api:app", "--host=0.0.0.0", "--port=8501"]
