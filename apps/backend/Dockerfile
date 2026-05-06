# syntax=docker/dockerfile:1.7

FROM rust:1.94-slim-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build the real binary in one shot. The dummy-source caching trick we
# tried earlier left a placeholder binary at target/release/shujian-backend
# that didn't get overwritten by the real build, so the runtime stage
# happily executed it and exited with "placeholder". Skip the trick — a
# clean cold build is ~3 min and reliable.
COPY Cargo.toml ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release && \
    cp target/release/shujian-backend /shujian-backend

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --user-group --uid 10001 shujian

WORKDIR /home/shujian
COPY --from=builder /shujian-backend ./shujian-backend
COPY migrations ./migrations
USER shujian

ENV PORT=8080 \
    HOST=0.0.0.0 \
    RUST_LOG=info,sqlx::query=warn

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["./shujian-backend"]
