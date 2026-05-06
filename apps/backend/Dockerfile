# syntax=docker/dockerfile:1.7

# Build stage — pull cargo deps first so iterative builds skip the heavy
# crate compilation when only src/ changes.
FROM rust:1-slim-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pre-fetch deps (cached layer)
COPY Cargo.toml ./
RUN mkdir -p src && echo 'fn main() { println!("placeholder"); }' > src/main.rs && \
    cargo build --release --locked 2>/dev/null || cargo build --release && \
    rm -rf src

# Real build
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release && \
    cp target/release/shujian-backend /shujian-backend && \
    rm -rf target

# Runtime stage — slim debian + ca-certs for outbound TLS, plus a non-root
# user so the binary doesn't run as root in production.
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
