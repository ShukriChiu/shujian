# Persona Spec v1

> Cross-service contract that lets `shujian-dashboard` render an AI persona's
> surface **without knowing anything about the business it operates on**, and
> lets a business backend (`onion-agent` today, anything else tomorrow) implement
> the data routes **without knowing how the dashboard renders them**.
>
> Add a new metric → write the YAML → both sides regenerate. Zero cross-repo
> hardcoding.

Last updated: 2026-05

---

## 0. Why a spec at all

Before this spec, we were about to make `shujian-backend` proxy
`/api/ai/business/snapshot` and decode the response — i.e. the control plane
would know "what KPIs exist on the boss-analyst persona" and "what fields they
contain". That's wrong. `shujian-*` is a tenant + credential plane; it has no
business knowing about *试听转化*, *fe_deals*, or *月度流水*.

The fix is to make the persona itself a self-describing manifest. The manifest
declares:

- *credentials* — which scopes it gets (already in v0)
- *behaviour* — system prompt + cursor settings (already in v0)
- **NEW: *surfaces* — `capabilities[]`, a typed list of "where data comes from
  and how to render it"**

The dashboard reads `capabilities`, picks a renderer per `layout`, fetches the
URL with the issued JWT. The business backend implements the URL. They never
import each other.

---

## 1. File layout & loading

```
personas/
  PERSONA_SPEC.md                ← this file
  spec/
    persona.schema.json          ← JSON Schema (draft 2020-12) for validation
  scripts/
    persona_validate.py          ← YAML → schema + sanity checks
    persona_brief.py             ← generate "AI implementation brief" for one
                                   capability, paste into Cursor/Claude
  onion_boss_analyst.yaml        ← one file per persona
  ...
```

YAML is the source of truth. They live in this repo so design changes are
reviewed alongside backend / dashboard PRs.

A small CLI (`personas/scripts/persona_sync.py`, future) will upsert YAML →
backend `POST /v1/personas`. Until that lands, the dashboard's persona editor
also accepts paste-and-save.

---

## 2. The schema, top to bottom

```yaml
spec_version: "1.0"           # required; SemVer-lite. Backend rejects unknowns.

# ── identity ────────────────────────────────────────────────────────────────
slug: onion_boss_analyst       # [a-z0-9_]+, unique per tenant
display_name: 洋葱老板·经营分析师
description: 给老板看的只读分析师，专做经营数据图表 + 决策建议
domain: analytics              # free-form tag; UI groups personas by it
tenant_slug: onion             # which tenant owns this persona

# ── credentials ─────────────────────────────────────────────────────────────
allowed_scopes:                # ⊆ vault_scopes(name) for this tenant
  - onion.readonly_business
  - onion.llm_openrouter
  - onion.api_base

# ── behaviour ───────────────────────────────────────────────────────────────
system_prompt: |
  你是趣学洋葱的经营分析师……

cursor_settings:
  runtime: cloud               # 'cloud' | 'local'
  model: composer-2
  permission_mode: plan        # 'plan' | 'default' | 'accept_edits' | 'auto' | 'supervised'
  tools_blacklist: [shell_exec, write_file]
  tools_whitelist: [http_fetch, read_file]
  setting_sources: [user]
  max_budget_usd: 0.50
  effort: high                 # 'min' | 'low' | 'medium' | 'high' | 'max'
  max_turns: 20
  auto_create_pr: false

# ── surfaces (the new bit) ──────────────────────────────────────────────────
capabilities:
  - id: business_snapshot
    label: 经营快照
    description: 当日 + 当月核心指标，给 workspace 顶部用
    layout: kpi_grid           # see §3 for the full enum
    placement: workspace_main  # see §4
    refresh_seconds: 60        # 0 = manual refresh only
    source:
      kind: http_get           # see §5
      url_template: "{ONION_API_BASE}/api/ai/business/snapshot"
      auth_env: ONION_API_TOKEN
      timeout_ms: 5000
    response_shape:            # informational; helps the brief generator
      example:
        today_deals: { count: 12, amount: 84000 }
        trial_conversion: { rate: 0.67, deals: 41, resolved: 61 }
        active_students: { count: 3245 }
        month_revenue: { count: 172, amount: 623241.49 }
    fields:                    # display mapping consumed by the renderer
      - { path: today_deals.amount,       label: 今日成交,  format: currency }
      - { path: trial_conversion.rate,    label: 试听转化,  format: percent  }
      - { path: active_students.count,    label: 在校学员,  format: count    }
      - { path: month_revenue.amount,     label: 本月流水,  format: currency }
```

---

## 3. `layout` — what kind of widget the dashboard renders

Each layout has a fixed renderer in `apps/dashboard/src/views/workspace/render/`.
Adding a new one = ship a renderer + register it. Keep this enum small.

| layout       | renderer accepts                                       | use for                              |
|--------------|--------------------------------------------------------|--------------------------------------|
| `kpi_grid`   | array of `{path, label, format}` over a single object  | dashboards: 4–6 numbers              |
| `line_chart` | object with `series: [{label, points: [[x,y]…]}]`      | trends over time                     |
| `bar_chart`  | object with `series` (categorical x)                   | per-brand / per-category breakdowns  |
| `table`      | `{ columns: [...], rows: [...] }`                      | row data with sorting/filter         |
| `markdown`   | `{ markdown: "..." }`                                  | freeform AI-written summaries        |
| `iframe`     | `{ url: "..." }`                                       | escape hatch (caution: cross-origin) |

`format` enum (used by `kpi_grid`, `table`):
`currency` · `percent` · `count` · `decimal` · `bytes` · `datetime` · `text`

---

## 4. `placement` — where in the dashboard the widget lives

| placement            | meaning                                                       |
|----------------------|---------------------------------------------------------------|
| `workspace_main`     | hero section above the chat                                    |
| `workspace_sidebar`  | right-side rail (collapsible)                                  |
| `agent_rail`         | shown in the agent detail rail under the chat                  |
| `hidden`             | available to the AI itself (via env), not rendered to humans   |

`hidden` is useful for capabilities that are purely "the AI calls this URL"
without needing a UI panel — the manifest still documents the capability so
the brief generator can scaffold the route.

---

## 5. `source.kind` — how the dashboard fetches data

| kind            | shape                                                         | notes                                     |
|-----------------|---------------------------------------------------------------|-------------------------------------------|
| `http_get`      | `{ url_template, auth_env, timeout_ms? }`                     | most KPIs                                 |
| `http_post`     | `{ url_template, auth_env, body_template, timeout_ms? }`      | search / filter widgets                   |
| `static`        | `{ value }`                                                   | for testing renderers without a backend   |
| `agent_tool`    | `{ tool_name }`                                               | result of the agent itself calling a tool |

`url_template` accepts `{ENV_VAR}` substitution. Substituted env vars must
appear in the resolved env from `allowed_scopes` (validator enforces).

`auth_env` is the env var to use as `Authorization: Bearer …`. Convention:
`ONION_API_TOKEN` for onion JWT, `OPENROUTER_API_KEY` for direct LLM, etc.

---

## 6. Codegen contract for the business backend (e.g. onion-agent)

Each `http_*` capability is a **route contract** for the backend that owns the
URL. Two helpers to make this easy:

### 6.1 `personas/scripts/persona_brief.py <slug> <capability_id>`

Prints a compact AI-implementation brief:

```
=== Capability brief for onion_boss_analyst.business_snapshot ===

ROUTE
  GET /api/ai/business/snapshot
  Auth: Authorization: Bearer <persona JWT>  (kind=ai_persona, readonly)

RESPONSE SHAPE (one example)
  {
    "today_deals":      { "count": 12, "amount": 84000 },
    ...
  }

FIELDS REFERENCED BY DASHBOARD
  today_deals.amount       (format=currency, label=今日成交)
  trial_conversion.rate    (format=percent,  label=试听转化)
  ...

DASHBOARD CONSTRAINTS
  - Refresh cadence: 60s (so keep p95 < 2s)
  - Timeout client-side: 5000ms
  - Renderer: kpi_grid

PASTE THIS BRIEF INTO CURSOR / CLAUDE TO GENERATE THE ROUTE.
```

Drop that into Cursor and ask "implement this in onion-agent" → it scaffolds
the route, the SQL, the pydantic response model. Zero hand-translation between
spec and code.

### 6.2 `personas/scripts/persona_validate.py <yaml>`

Validates against `spec/persona.schema.json`, plus extra checks:

- every `{ENV_VAR}` in `url_template` resolves from `allowed_scopes`'
  bindings on the active backend
- `fields[].path` matches a path in `response_shape.example` (catches typos)
- `cursor_settings` shape matches what `cursor-bridge` accepts
- `slug` is unique against backend's `agent_personas` for that tenant

---

## 7. What `shujian-backend` does and doesn't know

✅ Knows:
- The whole YAML (stored as JSONB row in `agent_personas`)
- How to mint a JWT for an `onion_jwt` binding
- Issuance log + revocation

❌ Doesn't know:
- What `business_snapshot` means
- What `today_deals.amount` is
- That `fe_deals` / `fe_trial_lessons` exist

Backend treats `capabilities` as opaque JSON. It only enforces:
- `allowed_scopes ⊆ vault_scopes` for the tenant
- env vars referenced by `auth_env` exist in the resolved env

Renderers + business routes are the only pieces that crack the manifest open.

---

## 8. Versioning

`spec_version` is required so we can evolve. Backend rejects unknown major
versions. Within v1.x:

- adding a new `layout` enum value = minor bump (renderers fall back to
  `markdown` rendering of `JSON.stringify` if they don't recognise it)
- adding a new optional field on a known section = minor
- changing the meaning of an existing field or removing one = MAJOR + new file
  per persona (`onion_boss_analyst.v2.yaml` etc.)

The dashboard ships with all known major versions' renderers; the backend
just stores whatever it gets.
