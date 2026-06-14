# Shujian Health

Oura Ring + SINO CGM sync service and five-layer health storyline analysis.

Stores data in the shared Railway Postgres (`health` schema) used by `apps/backend`.

## Multi-tenant model

| Layer | Storage | Purpose |
|-------|---------|---------|
| Service OAuth | `health.sino_oauth` | One SCRM account; auto refresh; survives redeploy |
| Tenant registry | `health.tenants` | `owner` → `sino_user_id`, `oura_pat` |
| Data | `health.*` tables | All rows keyed by `owner` |

CGM uses shared OAuth to pull different `sino_user_id` per tenant. Oura uses per-tenant `oura_pat`.

## Setup

```bash
cd apps/health
cp .env.example .env
# DATABASE_URL — same as apps/backend
# OAuth: SINO_CLIENT_ID/SECRET + ICAN_USERNAME/PASSWORD

uv sync
uv run health init
uv run health tenant add --owner shujian --sino-user-id <id> --oura-pat <pat>
```

## CLI

```bash
uv run health init
uv run health tenant list
uv run health tenant add --owner alice --sino-user-id ... --oura-pat ...

uv run health oura sync --days 7
uv run health oura sync --all          # all enabled tenants
uv run health oura today --owner alice

uv run health cgm sync --days 7
uv run health cgm sync --all
uv run health cgm today

uv run health storyline --days 14 --owner shujian
uv run health serve
```

## HTTP API

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness |
| `GET /api/health/auth` | SINO token mode/expiry (no secrets) |
| `POST /api/health/init` | Apply migrations + seed default tenant |
| `GET/POST /api/health/tenants` | Tenant registry |
| `POST /api/health/sync` | Sync Oura (+ optional CGM); `all_tenants: true` |
| `GET /api/health/today?owner=` | Oura + CGM brief |
| `GET /api/health/trend?source=oura\|cgm&owner=` | Trend text |
| `GET /api/health/storyline?days=14&owner=` | Storyline report |
| `GET /api/health/stats?owner=` | Row counts per table |

## Railway

Deploy as a service in the same project as `apps/backend`, referencing Postgres `DATABASE_URL`.

Required for CGM auto-refresh:

- `SINO_CLIENT_ID`, `SINO_CLIENT_SECRET`
- `ICAN_USERNAME`, `ICAN_PASSWORD`

Tenant secrets (`sino_user_id`, `oura_pat`) should be in `health.tenants` via `health tenant add` or the tenants API — not duplicated per deploy.

## Data migration from Supabase

```bash
uv run python scripts/migrate_from_supabase.py \
  --source "$BRAIN_DATABASE_URI" \
  --target "$DATABASE_URL"
```
