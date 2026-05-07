/**
 * Server-backed vault client.
 *
 * Talks to shujian-backend's `/v1/vault/*` endpoints (see
 * `apps/backend/src/vault/handlers.rs`). All values are encrypted at rest
 * with AES-256-GCM under a KEK that lives outside the database (early
 * stage: Railway env `SHUJIAN_VAULT_KEK_B64`; future: AWS KMS / 1Password
 * Connect — see ARCHITECTURE_VAULT.md §5).
 *
 * Read shape: the backend never returns ciphertext, never returns
 * plaintext. The only way to use a secret is to bind it into a vault
 * scope and launch a persona — see `ARCHITECTURE_VAULT.md`.
 */

import { BACKEND_BASE, BackendError, getActiveTenantId, getToken } from './backend'

export interface ServerSecretMetadata {
  id: string
  tenant_id: string
  name: string
  kind: string
  description: string | null
  kek_version: number
  metadata: Record<string, unknown>
  created_at: string
  rotated_at: string | null
  last_used_at: string | null
  created_by: string | null
}

/**
 * KEK status surfaced by `GET /v1/vault/_kek/status`. `source` is
 * intentionally a free-form string so we can introduce new providers
 * (`'kms:arn:aws:kms:...'`, `'1password://...'`) without breaking the
 * dashboard. Known values today:
 *   - `env_prod` — loaded from Railway env `SHUJIAN_VAULT_KEK_B64`
 *   - `env_dev`  — loaded from `SHUJIAN_VAULT_DEV_KEK_B64` (dev only)
 *   - `none`     — no KEK env configured; vault writes will 503
 */
export interface KekStatus {
  configured: boolean
  active_version: number | null
  fingerprint: string | null
  source: string
}

export interface OperatorRef {
  id: string
  tenant_id: string
  system: string
  operator_id: string
  operator_name: string
  is_shadow: boolean
  role_hint: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface VaultScope {
  id: string
  tenant_id: string
  name: string
  description: string | null
  bindings: Array<Record<string, unknown>>
  primary_operator_ref_id: string | null
  created_at: string
  updated_at: string
}

export type SecretKind = 'env' | 'jwt_signing' | 'webhook' | 'oauth' | 'r2_secret' | 'misc'

export const SECRET_KINDS: Array<{ value: SecretKind; label: string; hint: string }> = [
  { value: 'env', label: 'env', hint: '.env 风格的键值（默认）' },
  { value: 'r2_secret', label: 'r2', hint: 'R2 / S3 access key' },
  { value: 'webhook', label: 'webhook', hint: '钉钉 / Slack 等 webhook' },
  { value: 'oauth', label: 'oauth', hint: 'OAuth client secret' },
  { value: 'jwt_signing', label: 'jwt', hint: 'JWT 签名密钥' },
  { value: 'misc', label: 'misc', hint: '其它' },
]

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const tenant = getActiveTenantId()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['authorization'] = `Bearer ${token}`
  // Superusers can target a specific tenant; for normal users this header
  // is ignored by the backend in favour of the session's active tenant.
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

export const serverVaults = {
  kekStatus: () => call<KekStatus>('/v1/vault/_admin/kek'),

  listSecrets: (kind?: SecretKind) =>
    call<ServerSecretMetadata[]>(
      kind ? `/v1/vault/secrets?kind=${encodeURIComponent(kind)}` : '/v1/vault/secrets',
    ),

  getSecret: (name: string) =>
    call<ServerSecretMetadata>(`/v1/vault/secrets/${encodeURIComponent(name)}`),

  upsertSecret: (body: {
    name: string
    value: string
    kind?: SecretKind
    description?: string | null
    metadata?: Record<string, unknown>
  }) =>
    call<ServerSecretMetadata>('/v1/vault/secrets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteSecret: (name: string) =>
    call<{ deleted: string }>(`/v1/vault/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  listOperatorRefs: () => call<OperatorRef[]>('/v1/vault/operator-refs'),

  createOperatorRef: (body: {
    system: string
    operator_id: string
    operator_name: string
    is_shadow?: boolean
    role_hint?: string | null
    metadata?: Record<string, unknown>
  }) =>
    call<OperatorRef>('/v1/vault/operator-refs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteOperatorRef: (id: string) =>
    call<{ deleted: string }>(`/v1/vault/operator-refs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  listScopes: () => call<VaultScope[]>('/v1/vault/scopes'),

  upsertScope: (body: {
    name: string
    description?: string | null
    bindings: Array<Record<string, unknown>>
    primary_operator_ref_id?: string | null
  }) =>
    call<VaultScope>('/v1/vault/scopes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteScope: (name: string) =>
    call<{ deleted: string }>(`/v1/vault/scopes/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
}

/** Heuristic mirror of `lib/vaults.ts::looksLikeSecretKey`, kept here so
 *  serverVaults consumers don't have to import the local-vaults module. */
export function looksLikeSecretName(name: string): boolean {
  const k = name.toLowerCase()
  return (
    k.includes('key') ||
    k.includes('secret') ||
    k.includes('token') ||
    k.includes('password') ||
    k.includes('credential') ||
    k.includes('database_url') ||
    k.includes('redis_url') ||
    k.includes('access_key')
  )
}
