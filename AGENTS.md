# AGENTS.md

Instructions for AI coding agents (Cursor cloud agents, Claude, etc.) working in this monorepo.

## Repo layout

```
apps/
  agent/       Rust daemon                     (cwd for cargo commands)
  backend/     Rust + Axum control plane       (cwd for cargo commands)
  bridge/      Bun + Hono HTTP/SSE bridge      (cwd for `bun ...`)
  dashboard/   React + Vite local control UI   (cwd for `bun run dev/build`)
  future/      React + Vite talent management  (cwd for `bun run dev/build`)
packages/
  shared-types/                                shared TS types
```

This is a polyglot monorepo with **two coexisting workspace systems**:
- `Cargo.toml` (root) — Rust workspace, `members = ["apps/agent", "apps/backend"]`
- `package.json` (root) — Bun workspaces, `workspaces = ["apps/bridge", "apps/dashboard", "apps/future", "packages/*"]`

They do not interfere. Rust touches `Cargo.*` and `target/`; Bun touches `package.json` and `node_modules/`.

## Working-directory rules

When invoking commands, **`cd` into the relevant app directory first** unless the command is meant for the whole repo.

| Want to | Run | From |
|---------|-----|------|
| Build/run Rust agent | `cargo run` / `cargo build --release` | `apps/agent/` (or root via `-p shujian-agent`) |
| Run bridge dev server | `bun --watch src/server.ts` | `apps/bridge/` |
| Run dashboard dev server | `bunx vite` | `apps/dashboard/` |
| Run future dev server | `bunx vite` | `apps/future/` |
| Install all JS deps | `bun install` | repo root (hoisted across workspaces) |
| Type-check all TS | `bun run --filter '*' typecheck` | repo root |
| Add a Rust dep | edit `apps/agent/Cargo.toml`, then `cargo build` | `apps/agent/` |
| Add a TS dep to bridge | `bun add <pkg>` | `apps/bridge/` |

There is also a `Justfile` at the root that wraps the most common flows: `just dev-agent`, `just dev-bridge`, `just dev-dashboard`, `just dev-future`, `just check`.

## Cross-app changes

This monorepo's main reason to exist is **atomic cross-app edits**. When changing a contract that crosses boundaries (e.g. an agent ↔ bridge endpoint, or a bridge ↔ dashboard payload):

1. Define / update the type in `packages/shared-types/` first.
2. Update the producer (Rust struct in `apps/agent/` or Bun handler in `apps/bridge/`).
3. Update the consumer (`apps/bridge/` or `apps/dashboard/`).
4. Make a single commit / PR — never split a contract change across multiple PRs.

## Secrets

`.env` files are git-ignored at all paths. Never commit them. Each app keeps its own `.env.example` checked in.

## CI

Each app has its own workflow under `.github/workflows/`, scoped by `paths:` filter so unrelated edits don't trigger unrelated builds.

- `agent.yml` — `cargo fmt + clippy + test`, plus release-binary builds for macOS / Linux on tag push
- `bridge.yml` — `bun install --frozen-lockfile && bun run typecheck`, deploy to Railway on `main`
- `dashboard.yml` — `bun install && bun run build`, deploy to Cloudflare Pages on `main`
- `future.yml` — `bun install && bun run build`, deploy to Cloudflare Pages on `main`

## Don'ts

- Don't add a top-level `tsconfig.json` that tries to type-check Rust paths.
- Don't add `cargo` calls to `package.json` scripts (or vice versa). Use the `Justfile` for cross-language orchestration.
- Don't move secrets into the repo "just for CI"; use GitHub Actions secrets.
