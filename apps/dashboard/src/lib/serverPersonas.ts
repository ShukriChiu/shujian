/**
 * Server-backed persona client.
 *
 * Wraps `/v1/personas/*` on shujian-backend (see
 * `apps/backend/src/vault/handlers.rs::persona_routes`). The backend
 * stores personas as opaque rows; the *contract* lives in
 * `personas/PERSONA_SPEC.md`. This file mirrors that spec in TS so the
 * dashboard can render persona forms and dispatch capability widgets
 * without re-reading the YAML.
 *
 * Spec version this file targets: 1.x
 *
 * Three flows it supports:
 *
 *   1. CRUD              — list / get / upsert / delete
 *   2. Preview-env       — what envVars *would* a launch get? Default
 *                          masked; ?reveal=true mints real JWTs and
 *                          decrypts secrets (used by the wizard's
 *                          confirm step).
 *   3. Issue / Record / Revoke — full launch pipeline. Issue resolves
 *                          all bindings, mints onion JWTs, writes a
 *                          `vault_issuance_log` row, returns the env to
 *                          hand off to cursor-bridge. Record links the
 *                          cursor agent_id back to the audit row.
 *                          Revoke invalidates every minted JWT.
 */

import { BACKEND_BASE, BackendError, getActiveTenantId, getToken } from './backend'

// ─────────────────────────────────────────────────────────────────────────────
// Type system: mirrors personas/spec/persona.schema.json (v1)
// ─────────────────────────────────────────────────────────────────────────────

/** PERSONA_SPEC.md §3 — UI widgets the dashboard knows how to render. */
export type CapabilityLayout =
  | 'kpi_grid'
  | 'line_chart'
  | 'bar_chart'
  | 'table'
  | 'markdown'
  | 'iframe'

/** PERSONA_SPEC.md §4 — where the widget lives in the dashboard. */
export type CapabilityPlacement =
  | 'workspace_main'
  | 'workspace_sidebar'
  | 'agent_rail'
  | 'hidden'

/** PERSONA_SPEC.md §3 — accepted format hints for `kpi_grid` / `table`. */
export type FieldFormat = 'currency' | 'percent' | 'count' | 'decimal' | 'bytes' | 'datetime' | 'text'

export interface FieldMapping {
  path: string
  label: string
  format?: FieldFormat
  description?: string
  unit?: string
}

/** PERSONA_SPEC.md §5 — how the dashboard fetches the widget's data. */
export type CapabilitySource =
  | { kind: 'http_get'; url_template: string; auth_env?: string; timeout_ms?: number }
  | {
      kind: 'http_post'
      url_template: string
      auth_env?: string
      body_template?: unknown
      timeout_ms?: number
    }
  | { kind: 'static'; value: unknown }
  | { kind: 'agent_tool'; tool_name: string }

export interface PersonaCapability {
  id: string
  label: string
  description?: string
  layout: CapabilityLayout
  placement?: CapabilityPlacement
  refresh_seconds?: number
  source: CapabilitySource
  response_shape?: { example?: unknown; json_schema?: Record<string, unknown> }
  fields?: FieldMapping[]
}

export interface CursorSettings {
  runtime?: 'cloud' | 'local'
  model?: string
  permission_mode?: 'plan' | 'default' | 'accept_edits' | 'auto' | 'supervised'
  tools_whitelist?: string[]
  tools_blacklist?: string[]
  setting_sources?: Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>
  max_budget_usd?: number
  effort?: 'min' | 'low' | 'medium' | 'high' | 'max'
  max_turns?: number
  auto_create_pr?: boolean
  repo_url?: string
  starting_ref?: string
  // Open shape: backend stores the full object opaquely.
  [k: string]: unknown
}

export interface ServerPersona {
  id: string
  tenant_id: string
  slug: string
  display_name: string
  description: string | null
  system_prompt: string
  /** UUIDs in `vault_scopes` for this tenant. */
  allowed_scopes: string[]
  cursor_settings: CursorSettings
  domain: string | null
  spec_version: string
  capabilities: PersonaCapability[]
  created_at: string
  updated_at: string
}

export interface UpsertPersonaBody {
  slug: string
  display_name: string
  description?: string | null
  system_prompt: string
  allowed_scopes: string[]
  cursor_settings: CursorSettings
  domain?: string | null
  spec_version?: string
  capabilities?: PersonaCapability[]
}

/** One resolved env var from `preview-env` / `issue`. Plaintext is only
 *  populated when the caller asked for it (`reveal=true` or `issue`). */
export interface ResolvedEnvVar {
  env: string
  /** binding kind: 'static' | 'passthrough' | 'onion_jwt' | 'r2_presigned' */
  kind: string
  value: string | null
  value_len: number
  secret_name?: string | null
  operator_name?: string | null
  ttl_seconds?: number | null
  jti?: string | null
  /** unix epoch seconds */
  expires_at?: number | null
  readonly?: boolean | null
}

export interface PersonaPreview {
  persona: ServerPersona
  env: ResolvedEnvVar[]
  total_value_bytes: number
  cursor_settings: CursorSettings
  ok: boolean
  errors: string[]
}

export interface IssuanceResponse {
  /** Row id in `vault_issuance_log` — pass to record-launch / revoke. */
  id: string
  persona_id: string
  env: ResolvedEnvVar[]
  env_keys: string[]
  scope_ids: string[]
  /** Earliest minted-JWT expiry across all bindings, unix epoch seconds. */
  min_expires_at: number | null
  jtis: string[]
  cursor_settings: CursorSettings
}

export interface IssuanceLogRow {
  id: string
  tenant_id: string
  persona_id: string | null
  issued_to_user: string | null
  bridge_name: string | null
  cursor_agent_id: string | null
  cursor_run_id: string | null
  scope_ids: string[]
  env_keys: string[]
  /** Convenience pointer; same as `onion_jtis[0]` when set. */
  onion_jti: string | null
  onion_jtis: string[]
  metadata: Record<string, unknown>
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client (same pattern as serverVaults.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const tenant = getActiveTenantId()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['authorization'] = `Bearer ${token}`
  if (tenant) headers['x-tenant-id'] = tenant

  const res = await fetch(`${BACKEND_BASE}${path}`, { ...init, headers })
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (ct.includes('text/html') || text.startsWith('<!')) {
    throw new BackendError(502, `backend unreachable at ${BACKEND_BASE}${path}`)
  }
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'message' in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : typeof body === 'object' && body && 'error' in (body as Record<string, unknown>)
          ? String((body as Record<string, unknown>).error)
          : typeof body === 'string'
            ? body
            : `HTTP ${res.status}`
    throw new BackendError(res.status, msg)
  }
  return body as T
}

export const serverPersonas = {
  list: () => call<ServerPersona[]>('/v1/personas'),

  get: (slug: string) => call<ServerPersona>(`/v1/personas/${encodeURIComponent(slug)}`),

  upsert: (body: UpsertPersonaBody) =>
    call<ServerPersona>('/v1/personas', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  delete: (slug: string) =>
    call<{ deleted: string }>(`/v1/personas/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    }),

  /** Preview without minting JWTs / decrypting secrets. */
  previewEnv: (slug: string) =>
    call<PersonaPreview>(`/v1/personas/${encodeURIComponent(slug)}/preview-env`),

  /** Reveal: mints JWTs + decrypts secrets so the UI can show real
   *  countdowns and let the user copy values. Use sparingly — every
   *  call burns a JWT. */
  revealEnv: (slug: string) =>
    call<PersonaPreview>(`/v1/personas/${encodeURIComponent(slug)}/preview-env?reveal=true`),

  /** Full launch: writes audit row and returns the env to hand off. */
  issue: (
    slug: string,
    body: { bridge_name?: string; cursor_agent_id?: string; cursor_run_id?: string } = {},
  ) =>
    call<IssuanceResponse>(`/v1/personas/${encodeURIComponent(slug)}/issue`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Link an issuance to a Cursor agent_id post-launch. */
  recordLaunch: (
    issuanceId: string,
    body: { bridge_name?: string; cursor_agent_id: string; cursor_run_id?: string },
  ) =>
    call<{ ok: boolean; id: string }>(
      `/v1/personas/issuances/${encodeURIComponent(issuanceId)}/record-launch`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Revoke every JWT minted under an issuance. */
  revoke: (issuanceId: string, body: { reason?: string } = {}) =>
    call<{
      ok: boolean
      id: string
      revoked_jtis: string[]
      failed: Array<{ jti: string; error: string }>
    }>(`/v1/personas/issuances/${encodeURIComponent(issuanceId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listIssuances: (opts: { personaSlug?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.personaSlug) qs.set('persona_slug', opts.personaSlug)
    if (opts.limit) qs.set('limit', String(opts.limit))
    const tail = qs.toString()
    return call<IssuanceLogRow[]>(`/v1/personas/issuances${tail ? `?${tail}` : ''}`)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest helpers — pure functions used by both the form editor and the
// workspace capability renderer. No I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** Substitute `{ENV_VAR}` placeholders in a template string with values
 *  from the issued env. Throws if a referenced var is missing. */
export function substituteEnv(template: string, env: Record<string, string>): string {
  return template.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name]
    if (v === undefined) {
      throw new Error(`url_template references {${name}} but it's not in the issued env`)
    }
    return v
  })
}

/** Walk a dot-path through an arbitrary JSON value. Returns undefined
 *  if the path doesn't exist (instead of throwing) so renderers can
 *  show "—" gracefully. */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Lightweight value formatter the kpi_grid / table renderers share.
 *  Locale is hard-coded to 'zh-CN' since today's tenants are CN-only;
 *  swap to per-tenant when we need multi-locale. */
export function formatField(value: unknown, format?: FieldFormat, unit?: string): string {
  if (value === null || value === undefined) return '—'
  switch (format) {
    case 'currency':
      if (typeof value !== 'number') return String(value)
      return (
        (unit ?? '¥') + value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
      )
    case 'percent':
      if (typeof value !== 'number') return String(value)
      // The contract doesn't say whether 0–1 or 0–100; sniff: <=1 means
      // ratio, otherwise already a percent.
      const pct = value <= 1 ? value * 100 : value
      return `${pct.toFixed(1)}%`
    case 'count':
      if (typeof value !== 'number') return String(value)
      return value.toLocaleString('zh-CN')
    case 'decimal':
      if (typeof value !== 'number') return String(value)
      return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) + (unit ? ` ${unit}` : '')
    case 'bytes':
      if (typeof value !== 'number') return String(value)
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let u = 0
      let v = value
      while (v >= 1024 && u < units.length - 1) {
        v /= 1024
        u++
      }
      return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`
    case 'datetime':
      try {
        const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
        return d ? d.toLocaleString('zh-CN') : String(value)
      } catch {
        return String(value)
      }
    case 'text':
    default:
      return String(value)
  }
}

/** Mask a plaintext value for "reveal but not full disclosure" UI. */
export function maskRevealedValue(value: string | null | undefined): string {
  if (!value) return ''
  if (value.length <= 12) return '•'.repeat(value.length)
  return value.slice(0, 6) + '…' + value.slice(-4) + ` (${value.length} chars)`
}
