# shujian-backend — multi-tenant control plane

A small Rust service that owns identity, tenants, and (later) shared
secrets for the Shujian platform. Deployed on Railway alongside the
existing `bridge` service. Lives at `apps/backend/` in the monorepo.

## Why a separate service?

| Concern               | `apps/agent` (Rust)                 | `apps/bridge` (Bun/Hono)            | `apps/backend` (Rust + Axum)        |
| --------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| Scope                 | per-user **local daemon**           | per-deployment proxy to Cursor      | centralised control plane           |
| Tenancy               | none                                | none (today)                        | multi-tenant first class            |
| Persistence           | local jsonl files                   | in-memory + Cursor cloud            | **Postgres** (auth, audit, vaults)  |
| Lifetime              | runs while user is "in"             | long-lived SSE streams              | request/response                    |
| Scaling unit          | one per laptop                      | one per customer                    | one for the whole platform          |

Adding the auth/tenant logic to either of the existing services would
have entangled responsibilities (the daemon is a workstation tool; the
bridge is a stateless proxy). The backend is purposely the *only* place
where business identity lives.

## Stack

- **axum 0.8** + tower-http (tracing, request-id, CORS)
- **sqlx 0.8** with Postgres + `runtime-tokio` + `tls-rustls`
  - **No compile-time query macros** — we use the runtime `query` and
    `query_as` APIs so Railway's Docker build doesn't need a live DB.
    Trade-off: column type drift is caught at first hit, not at compile
    time. Tests + CI exercise the hot paths so the window is small.
- **argon2id** for password hashing (OWASP defaults)
- **Opaque session tokens**, not JWTs. 256 bits of `OsRng`, sha256-hashed
  before storage, mailed to the client once. Revocation = `DELETE FROM sessions`.
- **uuid v7** ids — time-ordered, friendly to Postgres indexes
- **JSON tracing** via `tracing-subscriber`

## Schema (`migrations/0001_init.sql`)

```
tenants                    users                       memberships             sessions
─────────────────────      ─────────────────────       ──────────────────      ─────────────────────
id      uuid (pk)          id      uuid (pk)           tenant_id (fk)          id          uuid
slug    unique             identifier unique           user_id   (fk)          user_id     fk users
name                       password_hash               role      enum         tenant_id   fk tenants?
display_name               display_name               PRIMARY KEY              token_hash  sha256(raw)
status  enum               status enum                  (tenant_id,             expires_at
metadata jsonb             is_superuser                  user_id)              last_active_at
created/updated_at         last_login_at                                       user_agent
                           metadata jsonb                                      created_at
                           created/updated_at
```

Notes:
- `users` has **no tenant column**. A user can belong to multiple
  tenants via `memberships`. Keeps invites and cross-org admins simple.
- `sessions.tenant_id` is the user's *current* tenant pointer. Switching
  tenants is just `UPDATE sessions ... WHERE id = ?`.
- All slugs and identifiers are stored lowercased; CHECK constraints
  enforce it.
- `roles` allowed: `owner`, `admin`, `member`, `viewer`.

## Endpoints (v0)

| Method | Path                              | Auth     | Notes                             |
| -----: | --------------------------------- | -------- | --------------------------------- |
| GET    | `/healthz`                        | public   | Liveness probe                    |
| GET    | `/readyz`                         | public   | Readiness — round-trips Postgres  |
| POST   | `/v1/auth/login`                  | public   | `{identifier, password}` → token  |
| POST   | `/v1/auth/logout`                 | bearer   | Deletes the current session       |
| GET    | `/v1/auth/me`                     | bearer   | Identity + memberships            |
| POST   | `/v1/auth/switch-tenant`          | bearer   | Update session's active tenant    |
| GET    | `/v1/tenants`                     | super    | List every tenant                 |
| POST   | `/v1/tenants`                     | super    | Create tenant                     |
| GET    | `/v1/tenants/:id/members`         | t.admin  | Tenant members                    |
| POST   | `/v1/tenants/:id/members`         | t.admin  | Upsert membership                 |

Auth header: `Authorization: Bearer <token>` where `<token>` is the raw
value returned by `/v1/auth/login`. The server stores only `sha256(token)`.

`super` = `users.is_superuser = true`. `t.admin` = the caller is either
a superuser or has `owner`/`admin` role on the target tenant.

## Bootstrap & seed data

`seed::ensure_seed` runs on every boot. On the first boot (no rows in
`tenants`) it creates:

- Tenant `onion` — *“趣学洋葱教育咨询有限公司”*
- Superuser `admin` with password **`admin`**
- Membership: `admin` is `owner` of `onion`

All seed values are env-overridable:

```
SEED_TENANT_SLUG=onion
SEED_TENANT_NAME=趣学洋葱
SEED_TENANT_DISPLAY_NAME=趣学洋葱教育咨询有限公司
SEED_ADMIN_IDENTIFIER=admin
SEED_ADMIN_PASSWORD=admin
```

> **Change the password before this thing meets the open internet.**
> Subsequent boots do *not* rotate the seed password — only the first
> bootstrap touches it.

## Local dev

You need a Postgres reachable on `DATABASE_URL`. Quickest path:

```bash
# Spin up a throwaway Postgres
docker run --rm -d --name shujian-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=shujian_backend \
  -p 5432:5432 \
  postgres:17

cp apps/backend/.env.example apps/backend/.env
cargo run -p shujian-backend
```

Migrations auto-apply on start (`sqlx::migrate!()`).

Run tests:

```bash
cargo test -p shujian-backend
```

## Production deployment (Railway)

`apps/backend/` ships a multi-stage `Dockerfile` and a `railway.toml`.
The Railway service is configured with:

- **Root directory:** `/apps/backend`
- **Dockerfile path:** `Dockerfile`
- **Healthcheck:** `/healthz`
- **Public domain:** `backend-production-fb29.up.railway.app`

Required env vars (already set in production):

- `DATABASE_URL` — `${{Postgres.DATABASE_URL}}` reference variable to the
  managed Postgres in the same project
- `CORS_ALLOW_ORIGINS` — comma-separated list of dashboard origins
- `SESSION_TTL_DAYS` — defaults to 30
- `SEED_*` — see above
- `RUST_LOG` — `info,sqlx::query=warn` is a sane default

Postgres lives in the same `shujian` project as the bridge so we keep
the deployment topology to a single project (bridge → Cursor cloud,
backend → Postgres + identity).

## Roadmap (next)

1. **Dashboard wiring** — login screen + bearer-token storage, replace
   the localStorage-only auth pretense.
2. **Vault server-side migration** — promote `apps/dashboard/src/lib/vaults.ts`
   from localStorage to a `vaults` table with envelope encryption (libsodium-style),
   gated by tenant membership.
3. **Audit log** — capture login, tenant switch, vault access. Tail
   into the dashboard for security review.
4. **Bridge integration** — bridge accepts an `Authorization: Bearer`
   header that it validates against backend `/v1/auth/me` (cached) so
   each cloud agent run is attributable to a real user.
5. **Password reset / invites** — token-based flow, plus email when we
   have an SMTP provider.
6. **Refresh tokens / device sessions** — for long-lived dashboards
   without rotating raw bearer tokens.

## Operational checklist

- [ ] Rotate the seed password the moment a real human logs in.
- [ ] Move `SEED_ADMIN_PASSWORD` out of plain-text env once #5 lands.
- [ ] Add `pg_cron` to GC expired sessions (right now it's lazy-on-read).
- [ ] Wire backend metrics into the dashboard's overview tile.
