/**
 * shujian-backend client for `apps/future`.
 *
 * Two surfaces:
 *  - Auth + admin endpoints — bearer token in localStorage, 401 = wipe
 *    + redirect to login. Same pattern as `apps/dashboard`.
 *  - Public apply endpoints — no token, no 401 redirect.
 *
 * `BACKEND_BASE` resolves at runtime:
 *   - VITE_BACKEND_URL env  → use as-is
 *   - dev mode              → `/backend` (Vite proxy → :8080)
 *   - prod fallback         → Railway deployment
 */

import type {
  FutureApplyPayload,
  FutureApplyResult,
  FutureAssignment,
  FutureCreateAssignment,
  FutureCreateNote,
  FutureCreateProject,
  FutureNote,
  FutureProject,
  FuturePublicTenantInfo,
  FutureShareLink,
  FutureStudentDetail,
  FutureStudentSummary,
  FutureUpdateAssignment,
  FutureUpdateProject,
  FutureUpdateShareLink,
  FutureUpdateStudent,
} from '@shujian/shared-types'

const TOKEN_KEY = 'shujian.future.token.v1'
const TENANT_KEY = 'shujian.future.tenant.v1'

const PROD_BACKEND_URL = 'https://backend-production-fb29.up.railway.app'

export const BACKEND_BASE: string = (() => {
  const envUrl = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '')
  if (envUrl) return envUrl
  if (import.meta.env.DEV) return '/backend'
  return PROD_BACKEND_URL
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
  constructor(
    public status: number,
    message: string,
  ) {
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

interface CallOptions extends Omit<RequestInit, 'body'> {
  /** Skip the bearer header (for public endpoints). */
  publicCall?: boolean
  /** Body that's already a string / FormData. JSON-encoding handled by `body`. */
  rawBody?: BodyInit
  /** Object to JSON-encode. Mutually exclusive with rawBody. */
  json?: unknown
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const { publicCall, rawBody, json, headers: rawHeaders, ...rest } = options
  const headers: Record<string, string> = {
    ...(rawHeaders as Record<string, string> | undefined),
  }
  if (json !== undefined && !rawBody) {
    headers['content-type'] = 'application/json'
  }
  if (!publicCall) {
    const token = getToken()
    if (token) headers['authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BACKEND_BASE}${path}`, {
    ...rest,
    headers,
    body:
      rawBody !== undefined
        ? rawBody
        : json !== undefined
          ? JSON.stringify(json)
          : undefined,
  })

  if (res.status === 204) return undefined as T

  if (res.status === 401 && !publicCall) {
    setToken(null)
    setActiveTenantId(null)
    onUnauthorized?.()
    throw new BackendError(401, 'unauthorized')
  }

  const ct = res.headers.get('content-type') ?? ''
  // The download endpoints stream binary — caller handles those by
  // calling fetch() directly (see `downloadResume` below).
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
    const bodyObj = body as Record<string, unknown> | undefined
    const msg =
      bodyObj && 'message' in bodyObj
        ? String(bodyObj.message)
        : bodyObj && 'error' in bodyObj
          ? String(bodyObj.error)
          : typeof body === 'string'
            ? body
            : `HTTP ${res.status}`
    throw new BackendError(res.status, msg)
  }
  return body as T
}

// ─── Auth ─────────────────────────────────────────────────────────────

export const auth = {
  login: async (
    identifier: string,
    password: string,
  ): Promise<LoginResponse> => {
    const raw = await call<BackendLoginResponse>('/v1/auth/login', {
      method: 'POST',
      json: { identifier, password },
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
      json: { tenant_id: tenantId },
    })
    const r = flattenMe(raw)
    if (r.current_tenant) setActiveTenantId(r.current_tenant.id)
    return r
  },
}

// ─── Public apply ─────────────────────────────────────────────────────

export const apply = {
  /** Fetch tenant header + open/closed flag for the apply page. */
  getTenantInfo: (token: string) =>
    call<FuturePublicTenantInfo>(`/v1/future/apply/${encodeURIComponent(token)}`, {
      publicCall: true,
    }),

  /** Submit a survey. `resume` is optional; ≤5 MB, PDF/Word/image. */
  submit: async (
    token: string,
    payload: FutureApplyPayload,
    resume: File | null,
  ): Promise<FutureApplyResult> => {
    const fd = new FormData()
    fd.append('payload', JSON.stringify(payload))
    if (resume) fd.append('resume', resume, resume.name)
    return call<FutureApplyResult>(
      `/v1/future/apply/${encodeURIComponent(token)}`,
      { method: 'POST', publicCall: true, rawBody: fd },
    )
  },
}

// ─── Admin: students ──────────────────────────────────────────────────

export const students = {
  list: (params: { status?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.q) qs.set('q', params.q)
    const suffix = qs.toString() ? `?${qs}` : ''
    return call<FutureStudentSummary[]>(`/v1/future/students${suffix}`)
  },

  get: (id: string) =>
    call<FutureStudentDetail>(`/v1/future/students/${id}`),

  update: (id: string, body: FutureUpdateStudent) =>
    call<FutureStudentDetail>(`/v1/future/students/${id}`, {
      method: 'PATCH',
      json: body,
    }),

  archive: (id: string) =>
    call<void>(`/v1/future/students/${id}`, { method: 'DELETE' }),

  /**
   * Resumes are streamed binary; bypass `call()` and use a plain fetch
   * + blob URL so we can trigger the browser download with the right
   * filename.
   */
  downloadResume: async (id: string): Promise<void> => {
    const token = getToken()
    const res = await fetch(`${BACKEND_BASE}/v1/future/students/${id}/resume`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    })
    if (!res.ok) {
      throw new BackendError(res.status, `download failed: HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const filename = parseFilename(res.headers.get('content-disposition'))
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename ?? '简历'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
}

function parseFilename(header: string | null): string | null {
  if (!header) return null
  // Expect: attachment; filename*=UTF-8''<percent-encoded>
  const m = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  const m2 = header.match(/filename="?([^"]+)"?/i)
  return m2?.[1] ?? null
}

// ─── Admin: notes ─────────────────────────────────────────────────────

export const notes = {
  list: (studentId: string) =>
    call<FutureNote[]>(`/v1/future/students/${studentId}/notes`),
  create: (studentId: string, body: FutureCreateNote) =>
    call<FutureNote>(`/v1/future/students/${studentId}/notes`, {
      method: 'POST',
      json: body,
    }),
  delete: (studentId: string, noteId: string) =>
    call<void>(`/v1/future/students/${studentId}/notes/${noteId}`, {
      method: 'DELETE',
    }),
}

// ─── Admin: projects ──────────────────────────────────────────────────

export const projects = {
  list: (params: { status?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    const suffix = qs.toString() ? `?${qs}` : ''
    return call<FutureProject[]>(`/v1/future/projects${suffix}`)
  },
  get: (id: string) => call<FutureProject>(`/v1/future/projects/${id}`),
  create: (body: FutureCreateProject) =>
    call<FutureProject>('/v1/future/projects', { method: 'POST', json: body }),
  update: (id: string, body: FutureUpdateProject) =>
    call<FutureProject>(`/v1/future/projects/${id}`, {
      method: 'PATCH',
      json: body,
    }),
  archive: (id: string) =>
    call<void>(`/v1/future/projects/${id}`, { method: 'DELETE' }),
  members: (id: string) =>
    call<FutureAssignment[]>(`/v1/future/projects/${id}/assignments`),
}

// ─── Admin: assignments ───────────────────────────────────────────────

export const assignments = {
  forStudent: (studentId: string) =>
    call<FutureAssignment[]>(`/v1/future/students/${studentId}/assignments`),
  create: (studentId: string, body: FutureCreateAssignment) =>
    call<FutureAssignment>(`/v1/future/students/${studentId}/assignments`, {
      method: 'POST',
      json: body,
    }),
  update: (
    studentId: string,
    projectId: string,
    body: FutureUpdateAssignment,
  ) =>
    call<FutureAssignment>(
      `/v1/future/students/${studentId}/assignments/${projectId}`,
      { method: 'PATCH', json: body },
    ),
  delete: (studentId: string, projectId: string) =>
    call<void>(`/v1/future/students/${studentId}/assignments/${projectId}`, {
      method: 'DELETE',
    }),
}

// ─── Admin: share link ────────────────────────────────────────────────

export const shareLink = {
  get: () => call<FutureShareLink>('/v1/future/share-link'),
  rotate: () =>
    call<FutureShareLink>('/v1/future/share-link/rotate', { method: 'POST' }),
  update: (body: FutureUpdateShareLink) =>
    call<FutureShareLink>('/v1/future/share-link', {
      method: 'PATCH',
      json: body,
    }),
}

// ─── Combined exports ─────────────────────────────────────────────────

export const backend = {
  ...auth,
  apply,
  students,
  notes,
  projects,
  assignments,
  shareLink,
}
