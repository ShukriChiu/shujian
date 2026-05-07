import { cursorAuthHeaders, cursorBase, LOCAL_ENDPOINT } from './bridges'

// shujian-agent (Rust) — proxied through Vite at /api → :8002
const AGENT_BASE = '/api'
// shujian-agent-bridge (Node + @cursor/sdk). The base URL comes from the
// active bridge in the registry — could be the Vite-proxied "/cursor" path
// for the local instance, or a full https://... origin for a remote one.
function isCursorUrl(url: string): boolean {
  return url.startsWith(LOCAL_ENDPOINT) || /^https?:\/\//.test(url)
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Auto-inject Cursor credential headers on every bridge call.
  const extraAuth = isCursorUrl(url) ? cursorAuthHeaders() : {}
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...extraAuth,
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  // Detect SPA fallback: hosting (Cloudflare Pages, Netlify, etc.) returns
  // index.html for unknown routes, which would otherwise look like a 200 OK
  // string body and crash callers that expect JSON. Treat it as a 502 so
  // useQuery surfaces an error state instead of corrupting downstream data.
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('text/html') || text.startsWith('<!doctype') || text.startsWith('<!DOCTYPE')) {
    throw new ApiError(
      502,
      `Endpoint not reachable: ${url} returned HTML (no API at this path in current deployment)`,
    )
  }
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      // keep text
    }
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).error)
        : typeof body === 'string'
          ? body
          : `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

// ---- shujian-agent (Rust) ----

export interface AgentDto {
  name: string
  workspace: string
  description: string | null
  model_category: string | null
  tools: string[] | null
  effective_model: string
  effective_provider: string
}

export interface TriggerDto {
  name: string
  trigger_type: string
  expr: string | null
  minutes: number | null
  reason: string
  agent: string | null
}

export interface TaskInfo {
  id: string
  agent: string
  message: string
  started_at: string
}

export interface DaemonStatus {
  uptime_secs: number
  active_tasks: TaskInfo[]
  tasks_completed: number
  tasks_failed: number
  max_concurrent: number
}

export interface HealthResponse {
  status: string
  agents: string[]
  version: string
}

export interface TaskResponse {
  success: boolean
  result: string
}

export interface TaskSubmitResponse {
  task_id: string
  agent: string
  status: string
}

export const agentApi = {
  health: () => request<HealthResponse>(`${AGENT_BASE}/health`),
  status: () => request<DaemonStatus>(`${AGENT_BASE}/status`),
  agents: () => request<AgentDto[]>(`${AGENT_BASE}/agents`),
  triggers: () => request<TriggerDto[]>(`${AGENT_BASE}/triggers`),
  runTaskSync: (body: { agent?: string; message: string; context?: string }) =>
    request<TaskResponse>(`${AGENT_BASE}/task/sync`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  submitTask: (body: { agent?: string; message: string; context?: string }) =>
    request<TaskSubmitResponse>(`${AGENT_BASE}/task`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

// ---- cursor-bridge (Node) ----

export interface CursorMe {
  apiKeyName: string
  userEmail?: string
  createdAt: string
}

export interface CursorModel {
  id: string
  displayName: string
  description?: string
}

export interface CursorAgent {
  agentId: string
  model?: { id: string }
}

/** Returned by `GET /agents/:id/meta` and embedded in create/update responses.
 *  Mirrors the bridge's `AgentMeta` shape so the dashboard can pre-fill the
 *  edit form without re-asking the user. */
export interface CursorAgentMeta {
  runtime: 'local' | 'cloud'
  modelId: string
  name?: string
  // cloud
  repoUrl?: string
  startingRef?: string
  envVars?: Record<string, string>
  autoCreatePR?: boolean
  // local
  cwd?: string
  settingSources?: Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>
}

export type CursorAgentWithMeta = CursorAgent & { runtime: string; meta?: CursorAgentMeta }

export interface CursorMessageResult {
  runId: string
  status: 'finished' | 'error' | 'cancelled'
  result?: string
  durationMs?: number
  git?: { branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> }
  model?: { id: string }
}

export interface CursorSkill {
  name: string
  description: string
  source: 'user' | 'project'
  path: string
}

export interface CursorUsage {
  source: 'session' | 'admin' | 'none'
  me: {
    email?: string
    name?: string
    sub?: string
    userId?: number
    apiKeyName?: string
  } | null
  plan: {
    available: boolean
    planName?: string
    price?: string
    includedAmountCents?: number
    hardLimitDollars?: number | null
    billingCycleStart?: string
    billingCycleEnd?: string
    membershipType?: string
    reason?: string
  }
  usage: {
    available: boolean
    planUsedCents?: number
    planLimitCents?: number
    planRemainingCents?: number
    planPercentUsed?: number
    onDemandUsedCents?: number
    onDemandLimitCents?: number
    onDemandRemainingCents?: number
    apiPercentUsed?: number
    autoPercentUsed?: number
    autoMessage?: string
    apiMessage?: string
    reason?: string
  }
  fetchedAt: string
  needs: { sessionToken: boolean; apiKey: boolean }
}

export interface CursorHealth {
  ok: boolean
  name?: string
  version?: string
  uptime?: number
  activeAgents?: number
  activeRuns?: number
}

export const cursorApi = {
  meta: () => request<{ service: string; version: string; activeAgents: number; activeRuns: number; name?: string }>(
    `${cursorBase()}/`,
  ),
  health: () => request<CursorHealth>(`${cursorBase()}/health`),
  me: () => request<CursorMe>(`${cursorBase()}/me`),
  models: () => request<CursorModel[]>(`${cursorBase()}/models`),
  repos: () => request<{ items: Array<{ url: string }> }>(`${cursorBase()}/repos`),
  list: () => request<{ items: CursorAgent[] }>(`${cursorBase()}/agents`),
  skills: (cwd: string, layers: Array<'project' | 'user'> = ['project', 'user']) =>
    request<{ items: CursorSkill[]; cwd: string }>(
      `${cursorBase()}/skills?cwd=${encodeURIComponent(cwd)}&layers=${layers.join(',')}`,
    ),
  usage: () => request<CursorUsage>(`${cursorBase()}/usage`),
  create: (body: {
    runtime?: 'local' | 'cloud'
    model?: string
    cwd?: string
    repoUrl?: string
    startingRef?: string
    /** dashboard cloud agents are read-only knowledgebase consumers; the
     *  wizard pins this to false and never exposes the toggle. Local
     *  runtime ignores it. */
    autoCreatePR?: boolean
    name?: string
    settingSources?: Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>
    envVars?: Record<string, string>
  }) =>
    request<CursorAgentWithMeta>(`${cursorBase()}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Re-spawn an agent with new settings (model, repo, envVars). Cursor
   *  cloud sandboxes are immutable, so this disposes the old one and
   *  starts a fresh one — the new agent gets a brand new agentId, which
   *  the caller must adopt. Conversation history does NOT carry over. */
  update: (
    id: string,
    body: Partial<{
      model: string
      repoUrl: string
      startingRef: string
      envVars: Record<string, string>
      name: string
    }>,
  ) =>
    request<{
      previousAgentId: string
      agentId: string
      model?: { id: string }
      runtime: string
      meta: CursorAgentMeta
    }>(`${cursorBase()}/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Read back the create-time options for an agent. Used by AgentEditor
   * to pre-fill the respawn form. Named `agentMeta` to avoid clashing
   * with `meta()` above (which returns bridge service info, not per-agent).
   */
  agentMeta: (id: string) =>
    request<{ agentId: string; meta: CursorAgentMeta }>(
      `${cursorBase()}/agents/${id}/meta`,
    ),
  dispose: (id: string) =>
    request<{ disposed: string }>(`${cursorBase()}/agents/${id}`, { method: 'DELETE' }),
  send: (id: string, message: string) =>
    request<CursorMessageResult>(`${cursorBase()}/agents/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  startStreamingRun: (id: string, message: string) =>
    request<{ runId: string; agentId: string; streamUrl: string }>(
      `${cursorBase()}/agents/${id}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
    ),
  /** Fan-out a one-shot probe to an arbitrary bridge endpoint without
   *  flipping the active bridge. Used by BridgesDialog for ad-hoc health
   *  checks while editing. */
  probeAt: async (endpoint: string, headers: Record<string, string>): Promise<CursorHealth> => {
    const res = await fetch(`${endpoint}/health`, { headers })
    if (!res.ok) return { ok: false }
    try {
      return (await res.json()) as CursorHealth
    } catch {
      return { ok: false }
    }
  },
}

export function buildCursorStreamUrl(agentId: string, runId: string): string {
  return `${cursorBase()}/agents/${agentId}/runs/${runId}/stream`
}

/** Build a streaming URL with auth as query params, for EventSource (which
 *  cannot set custom headers). Only needed for non-proxied remote bridges. */
export function buildCursorStreamUrlWithAuth(agentId: string, runId: string): string {
  const headers = cursorAuthHeaders()
  const params = new URLSearchParams()
  if (headers['X-Cursor-Api-Key']) params.set('apiKey', headers['X-Cursor-Api-Key'])
  if (headers['X-Cursor-Session-Token']) params.set('sessionToken', headers['X-Cursor-Session-Token'])
  const qs = params.toString()
  const base = `${cursorBase()}/agents/${agentId}/runs/${runId}/stream`
  return qs ? `${base}?${qs}` : base
}
