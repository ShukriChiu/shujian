default:
    @just --list

dev-bridge:
    cd apps/bridge && bun --watch src/server.ts

dev-dashboard:
    cd apps/dashboard && bunx vite

dev-agent:
    cd apps/agent && cargo run

check-rust:
    cargo fmt --check
    cargo clippy -- -D warnings
    cargo test

check-ts:
    bun run --filter '*' typecheck

check: check-rust check-ts

build-agent:
    cargo build --release -p shujian-agent

build-dashboard:
    cd apps/dashboard && bun install && bunx vite build

install:
    bun install
    cargo fetch
