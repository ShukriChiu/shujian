import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { Agent, Cursor, type SDKAgent } from '@cursor/sdk'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8003)
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? 'composer-2'
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd()
const BRIDGE_NAME = process.env.BRIDGE_NAME ?? 'local'
const BRIDGE_VERSION = '0.2.0'
const STARTED_AT = Date.now()

// Credentials are now provided per-request via headers from the dashboard.
// `.env` values still serve as a fallback for headless / CLI testing only.
const ENV_API_KEY = process.env.CURSOR_API_KEY
const ENV_SESSION_TOKEN = process.env.CURSOR_SESSION_TOKEN

const agents = new Map<string, SDKAgent>()
const runs = new Map<string, ReturnType<SDKAgent['send']> extends Promise<infer R> ? R : never>()

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'X-Cursor-Api-Key', 'X-Cursor-Session-Token'],
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Type'],
}))

/** Per-request credentials extracted from headers, with optional env fallback. */
function getApiKey(c: Context): string | undefined {
  const fromHeader = c.req.header('X-Cursor-Api-Key')
  return fromHeader && fromHeader.trim() ? fromHeader.trim() : ENV_API_KEY
}

function getSessionToken(c: Context): string | undefined {
  const fromHeader = c.req.header('X-Cursor-Session-Token')
  return fromHeader && fromHeader.trim() ? fromHeader.trim() : ENV_SESSION_TOKEN
}

app.get('/', (c) =>
  c.json({
    service: 'shujian-agent-bridge',
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    docs: 'https://cursor.com/cn/docs/sdk/typescript',
    activeAgents: agents.size,
    activeRuns: runs.size,
  }),
)

app.get('/health', (c) =>
  c.json({
    ok: true,
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    activeAgents: agents.size,
    activeRuns: runs.size,
    defaults: { model: DEFAULT_MODEL, cwd: DEFAULT_CWD },
  }),
)

app.get('/me', async (c) => {
  const apiKey = getApiKey(c)
  if (!apiKey) return c.json({ error: 'CURSOR_API_KEY missing' }, 401)
  try {
    const me = await Cursor.me({ apiKey })
    return c.json(me)
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/models', async (c) => {
  const apiKey = getApiKey(c)
  if (!apiKey) return c.json({ error: 'CURSOR_API_KEY missing' }, 401)
  try {
    const list = await Cursor.models.list({ apiKey })
    return c.json(list)
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// GitHub repos the API key's owner has connected to Cursor (via the
// Background Agents GitHub App). Used by the dashboard to populate the
// "Repo URL" picker when creating a cloud agent.
app.get('/repos', async (c) => {
  const apiKey = getApiKey(c)
  if (!apiKey) return c.json({ error: 'CURSOR_API_KEY missing' }, 401)
  try {
    const list = await Cursor.repositories.list({ apiKey })
    return c.json({ items: list })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// — slash-command skill discovery —
// Mirrors what `local.settingSources` will load behind the scenes, so the
// dashboard can render the same `/foo` autocomplete UX as the Cursor IDE.
interface SkillEntry {
  name: string
  description: string
  source: 'user' | 'project'
  path: string
}

const USER_SKILL_DIRS = [
  join(homedir(), '.cursor', 'skills-cursor'),
  join(homedir(), '.cursor', 'skills'),
]

async function dirExists(p: string): Promise<boolean> {
  try {
    const entries = await readdir(p)
    return entries.length >= 0
  } catch {
    return false
  }
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m || !m[1]) return {}
  const out: { name?: string; description?: string } = {}
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!kv || !kv[1]) continue
    const key = kv[1]
    let value = (kv[2] ?? '').trim()
    if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      const collected: string[] = []
      const next = lines[i + 1] ?? ''
      const startIndent = next.match(/^(\s+)/)?.[1]?.length ?? 2
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j] ?? ''
        if (!cont.trim()) {
          collected.push('')
          continue
        }
        const indent = cont.match(/^(\s*)/)?.[1]?.length ?? 0
        if (indent < startIndent) break
        collected.push(cont.slice(startIndent))
        i = j
      }
      value = collected.join(' ').replace(/\s+/g, ' ').trim()
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    if (key === 'name') out.name = value
    else if (key === 'description') out.description = value
  }
  return out
}

async function loadSkillsFrom(dir: string, source: SkillEntry['source']): Promise<SkillEntry[]> {
  if (!(await dirExists(dir))) return []
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: SkillEntry[] = []
  for (const name of entries) {
    const skillPath = join(dir, name, 'SKILL.md')
    try {
      const text = await readFile(skillPath, 'utf-8')
      const fm = parseFrontmatter(text)
      out.push({
        name: fm.name ?? name,
        description: (fm.description ?? '').slice(0, 280),
        source,
        path: skillPath,
      })
    } catch {
      // not a skill dir, skip
    }
  }
  return out
}

// — billing / usage —
// Two data sources are tried, in order:
//   1. WorkOS session token (cookie) → cursor.com/api/* — rich personal data
//   2. CURSOR_API_KEY (basic auth)   → api.cursor.com/teams/* — team admin only
const CURSOR_API_BASE = process.env.CURSOR_API_BASE ?? 'https://api.cursor.com'
const CURSOR_WEB_BASE = process.env.CURSOR_WEB_BASE ?? 'https://cursor.com'

function basicAuthHeader(apiKey: string): string {
  const token = Buffer.from(`${apiKey}:`).toString('base64')
  return `Basic ${token}`
}

function sessionCookieHeader(token: string): string {
  // The dashboard expects the WorkosCursorSessionToken cookie verbatim.
  return `WorkosCursorSessionToken=${token}`
}

interface UsagePlanBucket {
  enabled: boolean
  used: number
  limit: number
  remaining: number
  breakdown?: { included?: number; bonus?: number; total?: number }
  autoPercentUsed?: number
  apiPercentUsed?: number
  totalPercentUsed?: number
}

interface UsageSummary {
  billingCycleStart?: string
  billingCycleEnd?: string
  membershipType?: string
  isUnlimited?: boolean
  individualUsage?: {
    plan?: UsagePlanBucket
    onDemand?: UsagePlanBucket
  }
  autoModelSelectedDisplayMessage?: string
  namedModelSelectedDisplayMessage?: string
}

app.get('/usage', async (c) => {
  const sessionToken = getSessionToken(c)
  const apiKey = getApiKey(c)

  const out: {
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
  } = {
    source: 'none',
    me: null,
    plan: { available: false },
    usage: { available: false },
    fetchedAt: new Date().toISOString(),
    needs: { sessionToken: !sessionToken, apiKey: !apiKey },
  }

  // — 1) session-token path: cursor.com web API (richest data, personal accounts) —
  if (sessionToken) {
    const cookie = sessionCookieHeader(sessionToken)
    const headers = { Cookie: cookie, Accept: 'application/json' } as const

    try {
      const [meRes, summaryRes, planRes, hardRes] = await Promise.all([
        fetch(`${CURSOR_WEB_BASE}/api/auth/me`, { headers }),
        fetch(`${CURSOR_WEB_BASE}/api/usage-summary`, { headers }),
        fetch(`${CURSOR_WEB_BASE}/api/dashboard/get-plan-info`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        }),
        fetch(`${CURSOR_WEB_BASE}/api/dashboard/get-hard-limit`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ])

      if (meRes.ok) {
        const me = (await meRes.json()) as {
          email?: string
          name?: string
          sub?: string
          id?: number
        }
        out.me = { email: me.email, name: me.name, sub: me.sub, userId: me.id }
      }

      if (summaryRes.ok) {
        const sum = (await summaryRes.json()) as UsageSummary
        const plan = sum.individualUsage?.plan
        const ond = sum.individualUsage?.onDemand
        out.usage = {
          available: true,
          planUsedCents: plan?.used,
          planLimitCents: plan?.limit,
          planRemainingCents: plan?.remaining,
          planPercentUsed: plan?.totalPercentUsed,
          apiPercentUsed: plan?.apiPercentUsed,
          autoPercentUsed: plan?.autoPercentUsed,
          onDemandUsedCents: ond?.used,
          onDemandLimitCents: ond?.limit,
          onDemandRemainingCents: ond?.remaining,
          autoMessage: sum.autoModelSelectedDisplayMessage,
          apiMessage: sum.namedModelSelectedDisplayMessage,
        }
        out.plan = {
          ...out.plan,
          available: true,
          billingCycleStart: sum.billingCycleStart,
          billingCycleEnd: sum.billingCycleEnd,
          membershipType: sum.membershipType,
        }
        out.source = 'session'
      } else if (summaryRes.status === 401 || summaryRes.status === 403) {
        out.usage.reason = 'session token expired — 在 dashboard 设置里粘新的'
      } else {
        out.usage.reason = `${summaryRes.status} ${summaryRes.statusText}`
      }

      if (planRes.ok) {
        const pj = (await planRes.json()) as {
          planInfo?: {
            planName?: string
            includedAmountCents?: number
            price?: string
          }
        }
        out.plan = {
          ...out.plan,
          available: true,
          planName: pj.planInfo?.planName,
          price: pj.planInfo?.price,
          includedAmountCents: pj.planInfo?.includedAmountCents,
        }
      }

      if (hardRes.ok) {
        const hj = (await hardRes.json()) as { hardLimit?: number | null }
        out.plan.hardLimitDollars = hj.hardLimit ?? null
      }
    } catch (err) {
      out.usage.reason = err instanceof Error ? err.message : String(err)
    }
  }

  // — 2) admin API fallback — only if session path didn't yield usage and we have an API key
  if (!out.usage.available && apiKey) {
    try {
      const r = await fetch(`${CURSOR_API_BASE}/teams/spend`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageSize: 100 }),
      })
      if (r.ok) {
        const j = (await r.json()) as {
          teamMemberSpend?: Array<{
            userId: number
            spendCents: number
            overallSpendCents: number
            monthlyLimitDollars: number | null
          }>
        }
        const rows = j.teamMemberSpend ?? []
        const myRow = out.me?.userId ? rows.find((r) => r.userId === out.me!.userId) : rows[0]
        if (myRow) {
          out.usage = {
            available: true,
            planUsedCents: myRow.overallSpendCents,
          }
          out.source = 'admin'
        }
      } else if (!out.usage.reason) {
        out.usage.reason = `admin API: ${r.status} ${r.statusText}`
      }
    } catch (err) {
      if (!out.usage.reason) out.usage.reason = err instanceof Error ? err.message : String(err)
    }
  }

  // — 3) /me fallback — at least show api key owner if we have an API key but no session
  if (!out.me && apiKey) {
    try {
      const me = await Cursor.me({ apiKey })
      out.me = {
        email: me.userEmail,
        name: [me.userFirstName, me.userLastName].filter(Boolean).join(' ') || undefined,
        userId: me.userId,
        apiKeyName: me.apiKeyName,
      }
    } catch {
      // ignore
    }
  }

  return c.json(out)
})

app.get('/skills', async (c) => {
  const cwd = c.req.query('cwd') ?? DEFAULT_CWD
  const layers = (c.req.query('layers') ?? 'project,user').split(',') as Array<'project' | 'user'>

  const tasks: Promise<SkillEntry[]>[] = []
  if (layers.includes('user')) {
    for (const d of USER_SKILL_DIRS) tasks.push(loadSkillsFrom(d, 'user'))
  }
  if (layers.includes('project')) {
    tasks.push(loadSkillsFrom(join(cwd, '.cursor', 'skills'), 'project'))
  }
  const all = (await Promise.all(tasks)).flat()
  // de-dup by name (project wins over user)
  const seen = new Map<string, SkillEntry>()
  for (const s of all) {
    const prev = seen.get(s.name)
    if (!prev || (prev.source === 'user' && s.source === 'project')) {
      seen.set(s.name, s)
    }
  }
  const items = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ items, cwd })
})

app.get('/agents', (c) => {
  const items = Array.from(agents.entries()).map(([id, a]) => ({
    agentId: id,
    model: a.model,
  }))
  return c.json({ items })
})

app.post('/agents', async (c) => {
  const apiKey = getApiKey(c)
  if (!apiKey) return c.json({ error: 'CURSOR_API_KEY missing' }, 401)
  type CreateBody = {
    runtime?: 'local' | 'cloud'
    model?: string
    cwd?: string
    repoUrl?: string
    startingRef?: string
    autoCreatePR?: boolean
    name?: string
    /** Ambient Cursor settings layers to load (skills / MCP / sub-agents / hooks). */
    settingSources?: Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>
    /**
     * Cloud-only: per-session env vars injected into the cloud agent's shell.
     * Encrypted at rest by Cursor; deleted with the agent. Use to ship
     * caller-minted credentials (DATABASE_URL, REDIS_URL, etc.) so the
     * checked-out repo's code can read them without committing secrets.
     */
    envVars?: Record<string, string>
  }
  let body: CreateBody = {}
  try {
    body = await c.req.json<CreateBody>()
  } catch {}
  const runtime = body.runtime ?? 'local'
  const modelId = body.model ?? DEFAULT_MODEL

  try {
    let agent: SDKAgent
    if (runtime === 'cloud') {
      if (!body.repoUrl) return c.json({ error: 'cloud runtime 需要 repoUrl' }, 400)
      // Light validation: envVars must be a flat string→string map. We
      // strip empty keys/values to avoid Cursor rejecting the call.
      const envVars =
        body.envVars && typeof body.envVars === 'object'
          ? Object.fromEntries(
              Object.entries(body.envVars).filter(
                ([k, v]) => typeof k === 'string' && k && typeof v === 'string',
              ),
            )
          : undefined
      agent = await Agent.create({
        apiKey,
        name: body.name,
        model: { id: modelId },
        cloud: {
          repos: [{ url: body.repoUrl, startingRef: body.startingRef }],
          autoCreatePR: body.autoCreatePR ?? false,
          envVars: envVars && Object.keys(envVars).length ? envVars : undefined,
        },
      })
    } else {
      // Default to loading project + user setting layers so .cursor/skills/,
      // .cursor/mcp.json, .cursor/agents/*.md, .cursor/hooks.json all become available.
      const settingSources = body.settingSources ?? ['project', 'user']
      agent = await Agent.create({
        apiKey,
        name: body.name,
        model: { id: modelId },
        local: {
          cwd: body.cwd ?? DEFAULT_CWD,
          settingSources,
        },
      })
    }
    agents.set(agent.agentId, agent)
    return c.json({ agentId: agent.agentId, model: agent.model, runtime })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const agent = agents.get(id)
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  try {
    await agent[Symbol.asyncDispose]()
  } catch (err) {
    console.warn('[cursor-bridge] dispose failed', err)
  }
  agents.delete(id)
  return c.json({ disposed: id })
})

app.post('/agents/:id/messages', async (c) => {
  const id = c.req.param('id')
  const agent = agents.get(id)
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const body = await c.req.json<{ message: string }>()
  if (!body.message) return c.json({ error: 'message is required' }, 400)
  try {
    const run = await agent.send(body.message)
    runs.set(run.id, run)
    const result = await run.wait()
    return c.json({
      runId: run.id,
      status: result.status,
      result: result.result,
      durationMs: result.durationMs,
      git: result.git,
      model: result.model,
    })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

app.post('/agents/:id/runs', async (c) => {
  const id = c.req.param('id')
  const agent = agents.get(id)
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const body = await c.req.json<{ message: string }>()
  if (!body.message) return c.json({ error: 'message is required' }, 400)
  try {
    const run = await agent.send(body.message)
    runs.set(run.id, run)
    return c.json({
      runId: run.id,
      agentId: id,
      status: run.status,
      streamUrl: `/agents/${id}/runs/${run.id}/stream`,
    })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/agents/:id/runs/:runId/stream', (c) => {
  const runId = c.req.param('runId')
  const run = runs.get(runId)
  if (!run) return c.json({ error: 'run not found' }, 404)
  return streamSSE(c, async (sse) => {
    try {
      for await (const event of run.stream()) {
        await sse.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
      await sse.writeSSE({ event: 'done', data: JSON.stringify({ status: run.status, result: run.result }) })
    } catch (err) {
      await sse.writeSSE({ event: 'error', data: JSON.stringify({ message: String(err) }) })
    }
  })
})

app.post('/runs/:runId/cancel', async (c) => {
  const runId = c.req.param('runId')
  const run = runs.get(runId)
  if (!run) return c.json({ error: 'run not found' }, 404)
  await run.cancel()
  return c.json({ cancelled: runId, status: run.status })
})

// Bind to 0.0.0.0 in containers (Railway, Fly, Docker) so the platform proxy
// can reach us. Outside containers (local dev) Bun's default 127.0.0.1 is fine.
const HOSTNAME = process.env.HOSTNAME_BIND ?? (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.PORT ? '0.0.0.0' : '127.0.0.1')

console.log(`[cursor-bridge] listening on http://${HOSTNAME}:${PORT}`)
console.log(`[cursor-bridge] default model = ${DEFAULT_MODEL}`)
console.log(`[cursor-bridge] default cwd   = ${DEFAULT_CWD}`)

export default {
  port: PORT,
  hostname: HOSTNAME,
  // SSE streams + long agent runs need much more than Bun's 10s default
  idleTimeout: 255,
  fetch: app.fetch,
}
