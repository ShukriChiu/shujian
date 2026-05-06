# shujian

Monorepo for the Shujian agent stack: a Rust runtime daemon, a Cursor SDK bridge, and a React control panel.

## Apps

| Path | Stack | Role |
|------|-------|------|
| [`apps/agent`](apps/agent) | Rust (axum, tokio, cron) | Local daemon runtime for digital employees. Exposes HTTP, runs scheduled tasks, drives Cursor agents via the bridge. |
| [`apps/bridge`](apps/bridge) | TypeScript (Bun, Hono) + `@cursor/sdk` | HTTP/SSE bridge so any host (Rust agent, dashboard, cloud agent) can drive Cursor agents. |
| [`apps/backend`](apps/backend) | Rust (Axum, sqlx, Postgres) | Multi-tenant control plane: identity, tenants, sessions. See [`docs/backend-architecture.md`](docs/backend-architecture.md). |
| [`apps/dashboard`](apps/dashboard) | React 19 + Vite + Tailwind + TanStack | Web control panel for `apps/agent` and Cursor agents (via the bridge). |

## Packages

| Path | Description |
|------|-------------|
| [`packages/shared-types`](packages/shared-types) | TypeScript type definitions shared between bridge and dashboard. Future: codegen from Rust via `typeshare`. |

## Quick start

```bash
# install all JS deps + warm Rust cache
just install

# run each piece in its own terminal
just dev-agent
just dev-bridge
just dev-backend     # needs DATABASE_URL; see apps/backend/.env.example
just dev-dashboard

# checks before pushing
just check
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design (data flow, agent lifecycle, scheduler, Cursor bridge integration, etc.).

## Repo layout principles

- `apps/*` — deployable units, each owns its own `package.json` / `Cargo.toml`
- `packages/*` — shared libraries used across apps
- One CI workflow per app under `.github/workflows/`, scoped with `paths:` filters
- Cargo workspace and Bun workspace coexist at the root and ignore each other

## License

MIT
