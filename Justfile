default:
    @just --list

dev-bridge:
    cd apps/bridge && bun --watch src/server.ts

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
