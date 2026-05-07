/**
 * Manifest-driven capability renderer.
 *
 * Reads `persona.capabilities[]` (Persona Spec v1, see PERSONA_SPEC.md)
 * and dispatches each capability to a matching widget by `layout`. The
 * data source is resolved per-capability:
 *
 *   - source.kind = "static"     → render `value` directly
 *   - source.kind = "http_get"   → fetch with `Authorization: Bearer
 *                                  {auth_env}` after substituting
 *                                  `{ENV_VAR}` placeholders in
 *                                  url_template via the issued env
 *   - source.kind = "http_post"  → same as http_get + JSON body via
 *                                  `body_template`
 *   - source.kind = "agent_tool" → not yet wired (placeholder card)
 *
 * Refresh: every `refresh_seconds` if set; otherwise a manual reload
 * button only.
 *
 * The renderer is intentionally decoupled from `shujian-backend` —
 * URLs come from the persona's manifest, the dashboard never knows
 * about onion-agent's business shapes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import {
  formatField,
  getByPath,
  substituteEnv,
  type CapabilityPlacement,
  type FieldFormat,
  type FieldMapping,
  type PersonaCapability,
} from '@/lib/serverPersonas'
import { useCountUp } from '@/lib/useCountUp'
import { Markdown } from '@/views/agents/conversation/Markdown'

interface RendererProps {
  capabilities: PersonaCapability[]
  /** Resolved env from the issuance bundle. Used for both URL
   *  substitution and bearer-auth header building. */
  env: Record<string, string>
  /** Filter by placement; default = `workspace_main`. Use `'all'` to
   *  render every capability regardless of placement. */
  placement?: CapabilityPlacement | 'all'
}

export function CapabilityRenderer({ capabilities, env, placement = 'workspace_main' }: RendererProps) {
  const visible = useMemo(() => {
    if (placement === 'all') return capabilities
    return capabilities.filter((c) => (c.placement ?? 'workspace_main') === placement)
  }, [capabilities, placement])

  if (visible.length === 0) {
    return (
      <div className="m-5 rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-center text-[12px] text-ink-muted">
        这个 persona 没有声明 <span className="font-mono">workspace_main</span> 类型的 capability。
        到 <a className="text-accent underline" href="/personas">/personas</a> 加几个 KPI 试试。
      </div>
    )
  }

  return (
    <div className="space-y-4 p-5">
      {visible.map((c) => (
        <CapabilityCard key={c.id} capability={c} env={env} />
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Single capability card                                                      */
/* -------------------------------------------------------------------------- */

interface FetchState<T = unknown> {
  data: T | null
  error: string | null
  loading: boolean
  fetchedAt: number | null
}

function CapabilityCard({
  capability,
  env,
}: {
  capability: PersonaCapability
  env: Record<string, string>
}) {
  const [state, setState] = useState<FetchState>({ data: null, error: null, loading: false, fetchedAt: null })
  const abortRef = useRef<AbortController | null>(null)

  const fetchData = useCallback(async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await resolveSource(capability, env, ac.signal)
      setState({ data, error: null, loading: false, fetchedAt: Date.now() })
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      setState({
        data: null,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
        fetchedAt: Date.now(),
      })
    }
  }, [capability, env])

  // Initial + refresh-seconds polling.
  useEffect(() => {
    fetchData()
    const sec = capability.refresh_seconds ?? 0
    if (sec > 0) {
      const id = setInterval(fetchData, sec * 1000)
      return () => {
        clearInterval(id)
        abortRef.current?.abort()
      }
    }
    return () => abortRef.current?.abort()
  }, [fetchData, capability.refresh_seconds])

  return (
    <section
      className="overflow-hidden rounded-xl border border-line bg-surface animate-block-in"
      style={{ contain: 'layout paint' }}
    >
      <header className="flex items-center justify-between border-b border-line bg-surface-2/40 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{capability.label}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
              {capability.layout}
            </span>
          </div>
          {capability.description && (
            <div className="text-[11px] text-ink-muted">{capability.description}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {capability.refresh_seconds && (
            <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-dim">
              ↻ {capability.refresh_seconds}s
            </span>
          )}
          <button
            type="button"
            onClick={fetchData}
            disabled={state.loading}
            className="btn btn-ghost h-6 w-6 px-0"
            title="refresh"
            aria-label="refresh"
          >
            {state.loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </button>
        </div>
      </header>
      <div className="p-4">
        {state.error ? (
          <ErrorPanel error={state.error} onRetry={fetchData} />
        ) : (
          <CapabilityBody capability={capability} data={state.data} loading={state.loading} />
        )}
      </div>
    </section>
  )
}

function ErrorPanel({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-bad/40 bg-bad-tint px-3 py-2.5 text-[12px] text-bad">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11px] break-words">{error}</div>
        <button type="button" onClick={onRetry} className="mt-1.5 underline">
          retry
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Layout dispatcher                                                           */
/* -------------------------------------------------------------------------- */

function CapabilityBody({
  capability,
  data,
  loading,
}: {
  capability: PersonaCapability
  data: unknown
  loading: boolean
}) {
  if (loading && data === null) return <SkeletonForLayout layout={capability.layout} />
  switch (capability.layout) {
    case 'kpi_grid':
      return <KpiGrid fields={capability.fields ?? []} data={data} />
    case 'line_chart':
      return <ChartView data={data} kind="line" fields={capability.fields ?? []} />
    case 'bar_chart':
      return <ChartView data={data} kind="bar" fields={capability.fields ?? []} />
    case 'table':
      return <TableView data={data} fields={capability.fields ?? []} />
    case 'markdown':
      return <MarkdownView data={data} />
    case 'iframe':
      return <IframeView data={data} />
    default:
      return (
        <pre className="scroll-thin max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] text-ink-muted">
          {JSON.stringify(data, null, 2)}
        </pre>
      )
  }
}

function SkeletonForLayout({ layout }: { layout: string }) {
  if (layout === 'kpi_grid') {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-lg border border-line bg-surface-2/60" />
        ))}
      </div>
    )
  }
  return <div className="h-44 animate-pulse rounded-lg border border-line bg-surface-2/60" />
}

/* ---- kpi_grid ------------------------------------------------------------ */

function KpiGrid({ fields, data }: { fields: FieldMapping[]; data: unknown }) {
  if (fields.length === 0) {
    return (
      <div className="text-[11.5px] text-ink-muted">
        没声明 fields, 直接 dump JSON 看一眼:
        <pre className="scroll-thin mt-2 max-h-60 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px]">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {fields.map((f, i) => (
        <KpiCell key={f.path + i} mapping={f} value={getByPath(data, f.path)} />
      ))}
    </div>
  )
}

function KpiCell({ mapping, value }: { mapping: FieldMapping; value: unknown }) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null
  const tweened = useCountUp(numeric)
  const display =
    numeric !== null && tweened !== null && tweened !== undefined
      ? formatField(typeof tweened === 'number' ? tweened : numeric, mapping.format, mapping.unit)
      : formatField(value, mapping.format, mapping.unit)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-4 py-3 transition-shadow duration-150 ease-out-quart hover:shadow-ring-accent">
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-dim">
        {mapping.label}
      </div>
      <div className="text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
        {display}
      </div>
      {mapping.description && (
        <div className="text-[10.5px] leading-[1.4] text-ink-dim line-clamp-2">{mapping.description}</div>
      )}
    </div>
  )
}

/* ---- line_chart / bar_chart --------------------------------------------- */

function ChartView({
  data,
  kind,
  fields,
}: {
  data: unknown
  kind: 'line' | 'bar'
  fields: FieldMapping[]
}) {
  // Heuristic: data is either an array of objects directly, or `{ items: [...] }`.
  const series = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
      ? ((data as { items: unknown[] }).items as Array<Record<string, unknown>>)
      : []
  if (series.length === 0) {
    return <div className="text-[11.5px] text-ink-muted">empty series</div>
  }
  // First field becomes the X axis; subsequent numeric ones become bars / lines.
  const [xField, ...yFields] = fields
  const x = xField?.path ?? 'x'
  const yKeys = yFields.length > 0 ? yFields.map((f) => f.path) : ['y']
  const Chart = kind === 'line' ? RLineChart : RBarChart
  return (
    <div className="h-[260px]">
      <ResponsiveContainer>
        <Chart data={series as Record<string, unknown>[]}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey={x}
            tick={{ fill: 'var(--ink-dim)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
          />
          <YAxis
            tick={{ fill: 'var(--ink-dim)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: 'var(--ink-dim)' }} />
          {yKeys.map((k, i) =>
            kind === 'line' ? (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 4 }}
              />
            ) : (
              <Bar key={k} dataKey={k} fill={SERIES[i % SERIES.length]} radius={[4, 4, 0, 0]} />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  )
}

const SERIES = ['oklch(0.62 0.18 261)', 'oklch(0.65 0.16 165)', 'oklch(0.7 0.15 60)', 'oklch(0.6 0.18 25)']

/* ---- table -------------------------------------------------------------- */

function TableView({ data, fields }: { data: unknown; fields: FieldMapping[] }) {
  const rows: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
      ? ((data as { items: Array<Record<string, unknown>> }).items)
      : []
  if (rows.length === 0) return <div className="text-[11.5px] text-ink-muted">empty rows</div>
  // Derive columns from `fields` when present, else from first row's keys.
  const cols: Array<{ path: string; label: string; format?: FieldFormat; unit?: string }> =
    fields.length > 0
      ? fields.map((f) => ({ path: f.path, label: f.label, format: f.format, unit: f.unit }))
      : Object.keys(rows[0]).map((k) => ({ path: k, label: k }))
  return (
    <div className="scroll-thin max-h-[420px] overflow-auto rounded-md border border-line">
      <table className="w-full table-auto border-separate border-spacing-0 text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            {cols.map((c) => (
              <th
                key={c.path}
                className="border-b border-line px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-surface-2/40">
              {cols.map((c) => (
                <td
                  key={c.path}
                  className="border-b border-line px-3 py-1.5 font-mono text-[11.5px] tabular-nums text-ink"
                >
                  {formatField(getByPath(row, c.path), c.format, c.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---- markdown / iframe -------------------------------------------------- */

function MarkdownView({ data }: { data: unknown }) {
  const text =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object' && typeof (data as { markdown?: unknown }).markdown === 'string'
        ? ((data as { markdown: string }).markdown)
        : '```json\n' + JSON.stringify(data, null, 2) + '\n```'
  return (
    <div className="prose-shujian text-[13px]">
      <Markdown text={text} streaming={false} />
    </div>
  )
}

function IframeView({ data }: { data: unknown }) {
  const url =
    typeof data === 'string'
      ? data
      : typeof (data as { url?: unknown })?.url === 'string'
        ? ((data as { url: string }).url)
        : null
  if (!url) return <div className="text-[11.5px] text-ink-muted">no iframe url</div>
  return (
    <div className="space-y-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-[11px] text-accent underline"
      >
        <ExternalLink className="h-3 w-3" />
        open in new tab
      </a>
      <iframe
        src={url}
        title="capability"
        className={cn('h-[480px] w-full rounded-md border border-line bg-surface')}
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Source resolution                                                           */
/* -------------------------------------------------------------------------- */

async function resolveSource(
  capability: PersonaCapability,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const source = capability.source
  switch (source.kind) {
    case 'static':
      return source.value
    case 'http_get': {
      const url = substituteEnv(source.url_template, env)
      const headers: Record<string, string> = { accept: 'application/json' }
      if (source.auth_env) headers['authorization'] = `Bearer ${env[source.auth_env] ?? ''}`
      const res = await fetchWithTimeout(url, { method: 'GET', headers }, source.timeout_ms ?? 15_000, signal)
      return readJsonOrText(res)
    }
    case 'http_post': {
      const url = substituteEnv(source.url_template, env)
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
      }
      if (source.auth_env) headers['authorization'] = `Bearer ${env[source.auth_env] ?? ''}`
      const body = source.body_template !== undefined ? JSON.stringify(source.body_template) : undefined
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers, body },
        source.timeout_ms ?? 15_000,
        signal,
      )
      return readJsonOrText(res)
    }
    case 'agent_tool':
      throw new Error(
        `agent_tool source ("${source.tool_name}") not yet wired — call from the chat instead`,
      )
    default:
      throw new Error(`unknown source kind: ${(source as { kind?: string }).kind}`)
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), timeoutMs)
  outerSignal.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${truncate(text, 200) || res.statusText}`)
    }
    return res
  } finally {
    clearTimeout(timeoutId)
  }
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json()
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}
