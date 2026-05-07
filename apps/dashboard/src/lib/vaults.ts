/**
 * Vault registry.
 *
 * A "vault" = a named bundle of env vars. When you create a Cursor cloud
 * agent you can attach a vault and its `envs` will be injected into the
 * cloud VM's shell as `process.env.*` (via `CloudAgentOptions.envVars`).
 * Cursor encrypts envVars at rest and deletes them with the agent.
 *
 * Storage: shujian-backend (`/v1/vault/agent-vaults/*`). Each row is
 * encrypted at rest with AES-256-GCM under a per-row DEK that is itself
 * wrapped by the active KEK (see `apps/backend/src/vault/crypto.rs`).
 *
 * The hook surface intentionally still looks synchronous (`listVaults()`,
 * `getVault(id)`) so consumers can render from the in-memory cache. Reads
 * that need actual env values must go through the async `loadVault(id)`
 * — the list endpoint deliberately returns metadata only so we don't
 * waste KEK decryptions on every page render.
 */
import {
  BACKEND_BASE,
  BackendError,
  getActiveTenantId,
  getToken,
} from './backend'

const EVT = 'shujian-vaults-changed'

export interface Vault {
  id: string
  name: string
  /** Optional human note — what is this for, who owns it. */
  description?: string
  /**
   * Flat key→value map shipped as `CloudAgentOptions.envVars`. Empty until
   * `loadVault(id)` resolves; the list endpoint omits envs to skip
   * decryption. Always present (defaults to `{}`) so consumers can read
   * `vault.envs[X]` without optional-chaining gymnastics.
   */
  envs: Record<string, string>
  /** Free-form tags so users can group vaults (`prod`, `staging`, ...). */
  tags?: string[]
  /** Cached env key list — populated even when `envs` itself is unloaded. */
  envKeys: string[]
  /** ISO timestamps, useful for ordering / freshness checks. */
  createdAt: string
  updatedAt: string
  /**
   * Whether `envs` has been hydrated from the backend yet. Internal hint;
   * UI generally shouldn't need to read this — call `loadVault(id)` and
   * trust the cache after.
   */
  envsLoaded: boolean
}

interface ServerVaultDto {
  id: string
  tenant_id: string
  user_id: string
  name: string
  description: string
  tags: string[]
  env_keys: string[]
  env_count: number
  envs?: Record<string, string>
  created_at: string
  updated_at: string
}

let cache: Vault[] = []
let bootstrap: Promise<Vault[]> | null = null

function fromDto(d: ServerVaultDto, prevEnvs?: Record<string, string>): Vault {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? '',
    tags: d.tags ?? [],
    envKeys: d.env_keys ?? [],
    envs: d.envs ?? prevEnvs ?? {},
    envsLoaded: d.envs !== undefined || prevEnvs !== undefined,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }
}

function emit() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVT))
  }
}

/* ----------------------------- HTTP helpers ----------------------------- */

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

/* --------------------------------- API ---------------------------------- */

/** Synchronous read of the in-memory cache. Triggers a background fetch
 *  on first call so `useVaults()` can hydrate without an explicit `await`. */
export function listVaults(): Vault[] {
  if (!bootstrap && typeof window !== 'undefined' && getToken()) {
    bootstrap = fetchVaults().catch(() => [] as Vault[])
  }
  return cache
}

export function getVault(id: string): Vault | undefined {
  return cache.find((v) => v.id === id)
}

/** Refresh the cache from the server. Returns the new list. */
export async function fetchVaults(): Promise<Vault[]> {
  const dtos = await call<ServerVaultDto[]>('/v1/vault/agent-vaults')
  // Preserve already-loaded envs across refresh so opening a vault detail,
  // navigating away, and coming back doesn't blank out the cached envs.
  const prevById = new Map(cache.map((v) => [v.id, v.envs]))
  cache = dtos.map((d) => fromDto(d, prevById.get(d.id)))
  emit()
  return cache
}

/** Hydrate `vault.envs` for a single id. Decrypts on the server. */
export async function loadVault(id: string): Promise<Vault | null> {
  try {
    const dto = await call<ServerVaultDto>(
      `/v1/vault/agent-vaults/${encodeURIComponent(id)}`,
    )
    const next = fromDto(dto)
    const idx = cache.findIndex((v) => v.id === id)
    cache = idx >= 0
      ? [...cache.slice(0, idx), next, ...cache.slice(idx + 1)]
      : [...cache, next]
    emit()
    return next
  } catch (err) {
    if (err instanceof BackendError && err.status === 404) return null
    throw err
  }
}

export interface UpsertVaultInput {
  id: string
  name: string
  description?: string
  tags?: string[]
  envs: Record<string, string>
}

export async function upsertVault(input: UpsertVaultInput): Promise<Vault> {
  const dto = await call<ServerVaultDto>('/v1/vault/agent-vaults', {
    method: 'POST',
    body: JSON.stringify({
      id: input.id,
      name: input.name,
      description: input.description ?? '',
      tags: input.tags ?? [],
      envs: input.envs ?? {},
    }),
  })
  // Backend returns the row with envs populated, so we update the cache
  // optimistically without an extra round-trip.
  const next = fromDto({ ...dto, envs: input.envs })
  const idx = cache.findIndex((v) => v.id === input.id)
  cache = idx >= 0
    ? [...cache.slice(0, idx), next, ...cache.slice(idx + 1)]
    : [next, ...cache]
  emit()
  return next
}

export async function removeVault(id: string): Promise<void> {
  await call<{ deleted: string }>(
    `/v1/vault/agent-vaults/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
  cache = cache.filter((v) => v.id !== id)
  emit()
}

export function onVaultsChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVT, listener)
  return () => window.removeEventListener(EVT, listener)
}

export function genVaultId(): string {
  // Backend stores ids as Postgres `uuid`. crypto.randomUUID is everywhere
  // we need — modern browsers + Node 19+ for SSR.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  // Fallback: RFC 4122 v4 from Math.random — not cryptographically strong
  // but good enough as a unique id; encryption uses the server's DEK.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/* ----------------------------- mask helpers ----------------------------- */

/** Heuristic: does this key look like a secret? Used to mask values in
 *  read-only previews. Errs on the side of masking. */
export function looksLikeSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k.includes('key') ||
    k.includes('secret') ||
    k.includes('token') ||
    k.includes('password') ||
    k.includes('pwd') ||
    k.includes('credential') ||
    k.includes('private') ||
    k.includes('auth') ||
    k.includes('database_url') ||
    k.includes('redis_url') ||
    k.includes('mongodb_uri') ||
    k.includes('connection_string')
  )
}

/** Mask a value for preview: `sk_live_…ab12` style. */
export function maskValue(v: string): string {
  if (!v) return ''
  if (v.length <= 8) return '•'.repeat(Math.max(4, v.length))
  return `${v.slice(0, 4)}…${'•'.repeat(4)}${v.slice(-4)}`
}

/* ------------------------------ test hooks ------------------------------ */

/** Reset module state. Internal — only used by login/logout flows so a
 *  signed-out user doesn't see the previous user's cached metadata. */
export function _resetVaultsCache() {
  cache = []
  bootstrap = null
  emit()
}
