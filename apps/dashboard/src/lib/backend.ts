/**
 * shujian-backend client.
 *
 * Talks to the Rust/Axum tenant + auth service deployed on Railway.
 * Storage: opaque bearer token in localStorage. 401 = wipe + redirect.
 *
 * The `BACKEND_BASE` resolves at runtime from VITE_BACKEND_URL with a
 * dev-time fallback to /backend (proxied by Vite to the local server).
 */

const TOKEN_KEY = 'shujian.backend.token.v1'
const TENANT_KEY = 'shujian.backend.tenant.v1'

export const BACKEND_BASE: string = (() => {
  const envUrl = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')
  if (envUrl) return envUrl
  // dev fallback — Vite proxies /backend → :8080
  return '/backend'
})()

export interface UserPublic {
  id: string
  identifier: string
  display_name: string | null
  is_superuser: boolean
}

export interface TenantPublic {
  id: string
  slug: string
  name: string
  display_name: string | null
  status: string
  role?: string
}

interface BackendTenant {
  id: string
  slug: string
  name: string
  display_name: string | null
  status: string
}

interface BackendMembership {
  tenant: BackendTenant
  role: string
}

interface BackendMeResponse {
  user: UserPublic
  current_tenant: BackendTenant | null
  memberships: BackendMembership[]
}

interface BackendLoginResponse extends BackendMeResponse {
  token: string
  expires_at: string
}

export interface MeResponse {
  user: UserPublic
  current_tenant: TenantPublic | null
  tenants: TenantPublic[]
}

export interface LoginResponse extends MeResponse {
  token: string
  expires_at: string
}

function flattenMe<T extends BackendMeResponse>(r: T): T & MeResponse {
  const tenants = (r.memberships ?? []).map(
    (m): TenantPublic => ({ ...m.tenant, role: m.role }),
  )
  const current = r.current_tenant
    ? ({
        ...r.current_tenant,
        role: tenants.find((t) => t.id === r.current_tenant!.id)?.role,
      } as TenantPublic)
    : null
  return { ...r, tenants, current_tenant: current }
}

export class BackendError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* private mode */
  }
}

export function getActiveTenantId(): string | null {
  try {
    return window.localStorage.getItem(TENANT_KEY)
  } catch {
    return null
  }
}

export function setActiveTenantId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(TENANT_KEY, id)
    else window.localStorage.removeItem(TENANT_KEY)
  } catch {
    /* private mode */
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['authorization'] = `Bearer ${token}`

  const res = await fetch(`${BACKEND_BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    setToken(null)
    setActiveTenantId(null)
    onUnauthorized?.()
    throw new BackendError(401, 'unauthorized')
  }

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
      typeof body === 'object' && body && 'error' in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).error)
        : typeof body === 'string'
          ? body
          : `HTTP ${res.status}`
    throw new BackendError(res.status, msg)
  }
  return body as T
}

export const backend = {
  health: () => call<{ ok: true }>('/healthz'),

  login: async (identifier: string, password: string): Promise<LoginResponse> => {
    const raw = await call<BackendLoginResponse>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    })
    const r = flattenMe(raw)
    setToken(r.token)
    if (r.current_tenant) setActiveTenantId(r.current_tenant.id)
    else if (r.tenants[0]) setActiveTenantId(r.tenants[0].id)
    return r
  },

  logout: async () => {
    try {
      await call<{ ok: true }>('/v1/auth/logout', { method: 'POST' })
    } finally {
      setToken(null)
      setActiveTenantId(null)
    }
  },

  me: async (): Promise<MeResponse> => {
    const raw = await call<BackendMeResponse>('/v1/auth/me')
    return flattenMe(raw)
  },

  switchTenant: async (tenantId: string): Promise<MeResponse> => {
    const raw = await call<BackendMeResponse>('/v1/auth/switch-tenant', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId }),
    })
    const r = flattenMe(raw)
    if (r.current_tenant) setActiveTenantId(r.current_tenant.id)
    return r
  },
}
