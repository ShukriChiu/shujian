/**
 * Vault registry.
 *
 * A "vault" = a named bundle of env vars. When you create a Cursor cloud
 * agent you can attach a vault and its `envs` will be injected into the
 * cloud VM's shell as `process.env.*` (via `CloudAgentOptions.envVars`).
 * Cursor encrypts envVars at rest and deletes them with the agent.
 *
 * Storage strategy (PoC): vaults live in localStorage. This means:
 *   - Trust model = "whoever opens this dashboard owns these secrets",
 *     equivalent to a `.env` file on their disk.
 *   - Vaults don't sync across devices/browsers.
 *   - When the production dashboard is exposed publicly, gate it with
 *     Cloudflare Access (or similar) before storing real prod secrets.
 *   - Multi-tenant / team-shared vaults belong on the bridge once we add
 *     auth + persistence; the API surface here is intentionally small so
 *     it's easy to swap the backend later.
 */

const STORAGE_KEY = 'shujian.vaults.v1'
const EVT = 'shujian-vaults-changed'

export interface Vault {
  id: string
  name: string
  /** Optional human note — what is this for, who owns it. */
  description?: string
  /** Flat key→value map shipped as `CloudAgentOptions.envVars`. */
  envs: Record<string, string>
  /** Free-form tags so users can group vaults (`prod`, `staging`, ...). */
  tags?: string[]
  /** ISO timestamps, useful for ordering / freshness checks. */
  createdAt: string
  updatedAt: string
}

interface State {
  vaults: Vault[]
}

let cache: State | null = null

function emptyState(): State {
  return { vaults: [] }
}

function read(): State {
  if (cache) return cache
  if (typeof window === 'undefined') {
    cache = emptyState()
    return cache
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      cache = emptyState()
      return cache
    }
    const parsed = JSON.parse(raw) as Partial<Vault>[]
    const vaults = parsed
      .filter((v): v is Vault => !!v && !!v.id && !!v.name)
      .map((v) => ({
        id: v.id!,
        name: v.name!,
        description: v.description ?? '',
        envs: v.envs && typeof v.envs === 'object' ? { ...v.envs } : {},
        tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [],
        createdAt: v.createdAt ?? new Date().toISOString(),
        updatedAt: v.updatedAt ?? new Date().toISOString(),
      }))
    cache = { vaults }
  } catch {
    cache = emptyState()
  }
  return cache
}

function persist(state: State) {
  cache = state
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.vaults))
  } catch {
    // private mode — memory only
  }
  window.dispatchEvent(new CustomEvent(EVT))
}

export function listVaults(): Vault[] {
  return read().vaults
}

export function getVault(id: string): Vault | undefined {
  return read().vaults.find((v) => v.id === id)
}

export function upsertVault(v: Vault): void {
  const s = read()
  const now = new Date().toISOString()
  const idx = s.vaults.findIndex((x) => x.id === v.id)
  const merged: Vault = {
    ...v,
    createdAt: idx >= 0 ? s.vaults[idx]!.createdAt : v.createdAt || now,
    updatedAt: now,
  }
  const next =
    idx >= 0
      ? [...s.vaults.slice(0, idx), merged, ...s.vaults.slice(idx + 1)]
      : [...s.vaults, merged]
  persist({ vaults: next })
}

export function removeVault(id: string): void {
  const s = read()
  persist({ vaults: s.vaults.filter((v) => v.id !== id) })
}

export function onVaultsChange(listener: () => void): () => void {
  window.addEventListener(EVT, listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function genVaultId(): string {
  return `v_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36).slice(-4)}`
}

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
