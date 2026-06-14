# syntax=docker/dockerfile:1.7

FROM python:3.13-slim-bookworm AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

COPY pyproject.toml README.md ./
COPY src ./src
COPY migrations ./migrations

RUN uv pip install --system .

RUN useradd --create-home --user-group --uid 10001 health
USER health

ENV PORT=8090 \
    HOST=0.0.0.0

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1

CMD ["health", "serve"]
