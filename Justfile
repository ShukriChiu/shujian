default:
    @just --list

dev-bridge:
    cd apps/bridge && bun run dev

# Ephemeral tunnel (URL changes each run). Bridge must already be on :8003.
tunnel-quick:
    bash apps/bridge/scripts/tunnel-quick.sh

# One-time named tunnel setup. Requires HOSTNAME=bridge.yourdomain.com
tunnel-named-setup:
    bash apps/bridge/scripts/tunnel-named-setup.sh

# Run a named tunnel after tunnel-named-setup (bridge must be on :8003).
tunnel-run:
    cloudflared tunnel run ${TUNNEL_NAME:-shujian-bridge}

dev-dashboard:
    cd apps/dashboard && bunx vite

dev-future:
    cd apps/future && bunx vite

dev-agent:
    cd apps/agent && cargo run

# Backend (control plane). Needs a reachable Postgres on $DATABASE_URL.
# Quick local Postgres:
#   docker run --rm -d --name shujian-pg \
#     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=shujian_backend \
#     -p 5432:5432 postgres:17
dev-backend:
    cd apps/backend && cargo run

dev-health:
    cd apps/health && uv run health serve

check-rust:
    cargo fmt --check
    cargo clippy -- -D warnings
    cargo test

check-ts:
    bun run --filter '*' typecheck

check: check-rust check-ts

build-agent:
    cargo build --release -p shujian-agent

build-backend:
    cargo build --release -p shujian-backend

build-dashboard:
    cd apps/dashboard && bun install && bunx vite build

build-future:
    cd apps/future && bun install && bunx vite build

install:
    bun install
    cargo fetch
