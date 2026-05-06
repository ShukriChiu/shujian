import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  ChevronRight,
  Cloud,
  Cpu,
  Loader2,
  Plus,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { Conversation } from './conversation/Conversation'
import { agentApi, cursorApi, type AgentDto } from '@/lib/api'
import { useVaults } from '@/lib/useVaults'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { useUnifiedAgents } from './useUnifiedAgents'
import { makeId, parseId, type AgentKind, type UnifiedAgent } from './types'

type Filter = 'all' | 'local' | 'cursor' | 'running'

const FILTERS: Array<{ id: Filter; label: string; getCount: (c: ReturnType<typeof useUnifiedAgents>['counts']) => number }> = [
  { id: 'all', label: 'All', getCount: (c) => c.total },
  { id: 'running', label: 'Running', getCount: (c) => c.running },
  { id: 'local', label: 'Local', getCount: (c) => c.local },
  { id: 'cursor', label: 'Cloud', getCount: (c) => c.cursor },
]

/**
 * Apply a same-document view transition if the browser supports it,
 * otherwise just run the update synchronously.
 */
function withTransition(update: () => void) {
  type DocWithVT = Document & { startViewTransition?: (cb: () => void) => unknown }
  const d = document as DocWithVT
  if (typeof d.startViewTransition === 'function') {
    d.startViewTransition(() => update())
  } else {
    update()
  }
}

export function AgentsView() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('id')
  const newOpen = params.get('new') === '1'
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const data = useUnifiedAgents()

  const filtered = useMemo(() => {
    let items = data.items
    if (filter === 'local') items = items.filter((i) => i.kind === 'local')
    else if (filter === 'cursor') items = items.filter((i) => i.kind === 'cursor')
    else if (filter === 'running') items = items.filter((i) => i.status === 'running')
    if (q.trim()) {
      const term = q.trim().toLowerCase()
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(term) ||
          i.model.toLowerCase().includes(term) ||
          i.description?.toLowerCase().includes(term),
      )
    }
    return items
  }, [data.items, filter, q])

  const selected = filtered.find((i) => i.id === selectedId) ?? data.items.find((i) => i.id === selectedId)

  function selectId(id: string | null) {
    withTransition(() => {
      const next = new URLSearchParams(params)
      if (id) next.set('id', id)
      else next.delete('id')
      setParams(next, { replace: true })
    })
  }

  function openNew(kind: AgentKind = 'cursor') {
    const next = new URLSearchParams(params)
    next.set('new', '1')
    next.set('kind', kind)
    next.delete('id')
    setParams(next, { replace: true })
  }

  function closeNew() {
    const next = new URLSearchParams(params)
    next.delete('new')
    next.delete('kind')
    setParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Agents"
        description="本地 agent (Rust 运行时) 与云端 Cursor agent 同屏调度。"
        meta={
          <>
            <span className="font-mono">{data.counts.total}</span>
            <span aria-hidden>·</span>
            <span>
              {data.counts.running} <span className="text-ink-dim">running</span>
            </span>
          </>
        }
        actions={
          <button onClick={() => openNew('cursor')} className="btn btn-primary">
            <Plus className="h-4 w-4" />
            新建 Cloud Agent
          </button>
        }
      />

      <Toolbar filter={filter} setFilter={setFilter} counts={data.counts} q={q} setQ={setQ} />

      <div
        className={cn(
          'min-h-0 flex-1 grid transition-[grid-template-columns] duration-300 ease-out-quart',
          selected || newOpen
            ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]'
            : 'grid-cols-1',
        )}
      >
        <AgentList
          items={filtered}
          isLoading={data.isLoading}
          selectedId={selectedId}
          onSelect={selectId}
          onOpenNew={() => openNew('cursor')}
        />
        {(selected || newOpen) && (
          <aside
            className="hidden border-l border-line bg-surface xl:flex xl:min-h-0 xl:flex-col"
            style={{ viewTransitionName: 'agent-rail' } as React.CSSProperties}
          >
            {newOpen ? (
              <NewAgentRail onClose={closeNew} onCreated={(id) => selectId(id)} />
            ) : selected ? (
              <AgentRail agent={selected} onClose={() => selectId(null)} />
            ) : null}
          </aside>
        )}
      </div>
    </div>
  )
}

function Toolbar({
  filter,
  setFilter,
  counts,
  q,
  setQ,
}: {
  filter: Filter
  setFilter: (f: Filter) => void
  counts: ReturnType<typeof useUnifiedAgents>['counts']
  q: string
  setQ: (q: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-line bg-bg/60 px-6 py-2.5 backdrop-blur">
      <div className="flex items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
              filter === f.id
                ? 'bg-surface-2 text-ink'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <span>{f.label}</span>
            <span
              className={cn(
                'rounded font-mono text-[10px]',
                filter === f.id ? 'text-accent' : 'text-ink-dim',
              )}
            >
              {f.getCount(counts)}
            </span>
          </button>
        ))}
      </div>
      <div className="ml-auto flex h-7 w-[260px] items-center gap-2 rounded-md border border-line bg-surface-2 px-2 text-xs text-ink-muted focus-within:border-accent focus-within:shadow-ring-accent">
        <Search className="h-3.5 w-3.5 text-ink-dim" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜 name / model / 描述"
          className="h-full flex-1 bg-transparent text-ink outline-none placeholder:text-ink-dim"
          aria-label="Filter agents"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            className="text-ink-dim hover:text-ink"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

function AgentList({
  items,
  isLoading,
  selectedId,
  onSelect,
  onOpenNew,
}: {
  items: UnifiedAgent[]
  isLoading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onOpenNew: () => void
}) {
  if (isLoading) {
    return (
      <div className="px-6 py-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line py-3">
            <span className="skeleton h-2 w-2 rounded-full" />
            <span className="skeleton h-4 w-44" />
            <span className="skeleton h-3.5 w-24" />
            <span className="skeleton ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="px-6 py-10">
        <EmptyState
          glyph={<Bot className="h-5 w-5" />}
          title="还没有 agent"
          hint={
            <>
              本地 agent 来自 <span className="text-ink-muted">.cursor/agents/*.md</span>{' '}
              + <span className="text-ink-muted">config.toml</span>，
              <br />
              云端 agent 由 cursor-bridge 在 Cursor cloud 里 spawn。
            </>
          }
          action={
            <button onClick={onOpenNew} className="btn btn-primary">
              <Plus className="h-4 w-4" /> 新建 Cloud Agent
            </button>
          }
        />
      </div>
    )
  }
  return (
    <div className="overflow-y-auto scroll-thin">
      <Header />
      {items.map((a) => (
        <Row key={a.id} item={a} active={a.id === selectedId} onSelect={() => onSelect(a.id)} />
      ))}
    </div>
  )
}

const ROW_GRID = 'grid-cols-[14px_minmax(0,1.4fr)_minmax(0,0.55fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_72px]'

function Header() {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 grid items-center gap-3 border-b border-line bg-bg/95 px-6 py-2 backdrop-blur',
        ROW_GRID,
      )}
    >
      <span />
      <span className="row-head">Name</span>
      <span className="row-head">Kind</span>
      <span className="row-head">Model</span>
      <span className="row-head">Workspace</span>
      <span className="row-head text-right">Tools</span>
    </div>
  )
}

function Row({
  item,
  active,
  onSelect,
}: {
  item: UnifiedAgent
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'grid w-full items-center gap-3 border-b border-line px-6 py-3 text-left text-sm transition-colors',
        ROW_GRID,
        active ? 'bg-[var(--accent-tint)]' : 'hover:bg-surface-2',
      )}
      aria-current={active ? 'true' : undefined}
    >
      <span
        className={cn(
          'dot',
          item.status === 'running'
            ? 'dot-running'
            : item.status === 'failed'
              ? 'dot-bad'
              : item.kind === 'local'
                ? 'dot-ok'
                : 'dot-idle',
        )}
        aria-label={item.status}
      />
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="truncate font-medium text-ink">{item.name}</span>
        {item.description && (
          <span className="hidden truncate text-xs text-ink-dim md:inline">
            {item.description}
          </span>
        )}
      </span>
      <span className="flex items-center">
        <KindPill kind={item.kind} />
      </span>
      <span className="flex items-center gap-1.5 truncate font-mono text-xs text-ink-muted">
        <span className="truncate">{item.model}</span>
      </span>
      <span className="truncate font-mono text-xs text-ink-dim">
        {item.workspace ?? (item.kind === 'cursor' ? 'cursor cloud' : '—')}
      </span>
      <span className="text-right font-mono text-xs text-ink-dim">
        {item.toolsCount ?? '—'}
      </span>
    </button>
  )
}

function KindPill({ kind }: { kind: AgentKind }) {
  if (kind === 'local') {
    return (
      <span className="pill pill-muted">
        <Cpu className="h-3 w-3" />
        local
      </span>
    )
  }
  return (
    <span className="pill pill-accent">
      <Cloud className="h-3 w-3" />
      cloud
    </span>
  )
}

// — RAILS —

function AgentRail({ agent, onClose }: { agent: UnifiedAgent; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'dot',
              agent.status === 'running' ? 'dot-running' : agent.kind === 'local' ? 'dot-ok' : 'dot-idle',
            )}
          />
          <span className="truncate font-mono text-sm text-ink">{agent.name}</span>
        </div>
        <button
          onClick={onClose}
          className="btn btn-ghost h-7 w-7 px-0"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {agent.kind === 'local' ? <LocalRail agent={agent} /> : <CursorRail agent={agent} />}
      </div>
    </div>
  )
}

function LocalRail({ agent }: { agent: UnifiedAgent }) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')
  const [context, setContext] = useState('')
  const [history, setHistory] = useState<
    Array<{ id: string; ok: boolean; ms: number; req: string; res: string }>
  >([])

  const run = useMutation({
    mutationFn: async () => {
      const t0 = performance.now()
      const r = await agentApi.runTaskSync({
        agent: agent.name,
        message,
        context: context.trim() || undefined,
      })
      return { r, ms: Math.round(performance.now() - t0) }
    },
    onSuccess: ({ r, ms }) => {
      setHistory((p) => [
        { id: crypto.randomUUID().slice(0, 8), ok: r.success, ms, req: message, res: r.result },
        ...p,
      ].slice(0, 8))
      setMessage('')
      qc.invalidateQueries({ queryKey: ['agent', 'status'] })
    },
  })

  const dto = agent.raw as AgentDto

  return (
    <div className="flex h-full flex-col overflow-y-auto scroll-thin">
      <section className="space-y-3 border-b border-line p-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
          Configuration
        </div>
        <KV label="model" value={dto.effective_model} mono />
        <KV label="provider" value={dto.effective_provider} mono />
        <KV label="workspace" value={dto.workspace} mono />
        {dto.description && <KV label="description" value={dto.description} />}
        {dto.tools && <KV label="tools" value={`${dto.tools.length} (${dto.tools.slice(0, 3).join(', ')}${dto.tools.length > 3 ? ', …' : ''})`} mono />}
      </section>

      <section className="space-y-3 border-b border-line p-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
          Dispatch
        </div>
        <textarea
          className="textarea text-sm"
          placeholder="任务描述，例如：扫今天新入库证照并提取关键字段"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
        />
        <textarea
          className="textarea font-mono text-xs"
          placeholder="附加上下文 / JSON / Markdown（可选）"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={2}
        />
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-ink-dim">/api/task/sync</span>
          <button
            className="btn btn-primary"
            disabled={!message.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {run.isPending ? '执行中' : '派单'}
          </button>
        </div>
        {run.error && (
          <div
            className="rounded-md px-3 py-2 text-xs"
            style={{
              border: '1px solid oklch(var(--bad-l) var(--bad-c) var(--bad-h) / 0.42)',
              background: 'var(--bad-tint)',
              color: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h))',
            }}
          >
            {(run.error as Error).message}
          </div>
        )}
      </section>

      <section className="flex-1 p-5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
            Recent runs ({history.length})
          </div>
          {history.length > 0 && (
            <button onClick={() => setHistory([])} className="btn btn-ghost h-7 px-2 text-xs">
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="mt-3 text-xs text-ink-dim">本会话内还没有派单结果。</div>
        ) : (
          <ul className="mt-3 space-y-3">
            {history.map((h) => (
              <li key={h.id} className="rounded-md border border-line bg-surface-2 p-3">
                <div className="flex items-center justify-between text-[11px] text-ink-dim">
                  <span className="font-mono">{h.id}</span>
                  <span className="font-mono">{(h.ms / 1000).toFixed(2)}s</span>
                  <span className={h.ok ? 'pill pill-ok' : 'pill pill-bad'}>
                    {h.ok ? 'OK' : 'FAILED'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-ink">{h.req}</div>
                <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-muted scroll-thin">
                  {h.res || '(空响应)'}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function CursorRail({ agent }: { agent: UnifiedAgent }) {
  const qc = useQueryClient()
  const [configOpen, setConfigOpen] = useState(false)

  const dispose = useMutation({
    mutationFn: () => cursorApi.dispose(agent.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cursor', 'list'] }),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line">
        <button
          type="button"
          onClick={() => setConfigOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-dim transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-ink-muted"
          aria-expanded={configOpen}
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform duration-150 ease-out-quart',
              configOpen && 'rotate-90',
            )}
          />
          configuration
          <span className="ml-2 font-mono normal-case tracking-normal text-ink-muted">
            {agent.model}
          </span>
          <span className="pill pill-muted ml-auto normal-case tracking-normal">cursor cloud</span>
        </button>
        {configOpen && (
          <div className="space-y-2.5 border-t border-line bg-surface/50 px-5 py-4 animate-block-in">
            <KV label="agent id" value={agent.name} mono />
            <KV label="model" value={agent.model} mono />
            {agent.repoUrl && <KV label="repo" value={agent.repoUrl} mono />}
            <KV label="provider" value="cursor cloud" mono />
            <div className="flex justify-end pt-1">
              <button
                onClick={() => dispose.mutate()}
                disabled={dispose.isPending}
                className="btn btn-ghost h-7 px-2 text-xs hover:text-bad"
              >
                <Trash2 className="h-3 w-3" />
                {dispose.isPending ? 'Disposing' : 'Dispose'}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Conversation agentId={agent.name} repoLabel={agent.repoUrl} />
      </div>
    </div>
  )
}

// — NEW AGENT —

function NewAgentRail({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const vaults = useVaults()
  const repos = useQuery({
    queryKey: ['cursor', 'repos'],
    queryFn: cursorApi.repos,
    retry: 0,
    staleTime: 60_000,
  })
  const models = useQuery({
    queryKey: ['cursor', 'models'],
    queryFn: cursorApi.models,
    retry: 0,
  })
  const me = useQuery({ queryKey: ['cursor', 'me'], queryFn: cursorApi.me, retry: 0 })

  const [name, setName] = useState('')
  const [model, setModel] = useState('claude-4.6-sonnet')
  const [repoUrl, setRepoUrl] = useState('')
  const [startingRef, setStartingRef] = useState('main')
  const [autoCreatePR, setAutoCreatePR] = useState(true)
  const [vaultId, setVaultId] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const create = useMutation({
    mutationFn: () => {
      const vault = vaultId ? vaults.find((v) => v.id === vaultId) : undefined
      const envVars = vault ? { ...vault.envs } : undefined
      return cursorApi.create({
        runtime: 'cloud',
        model,
        repoUrl: repoUrl.trim() || undefined,
        startingRef: startingRef.trim() || undefined,
        autoCreatePR,
        name: name.trim() || undefined,
        envVars,
      })
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
      onCreated(makeId('cursor', a.agentId))
    },
  })

  const canSubmit = !create.isPending && (me.data?.apiKeyName || me.isLoading)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    create.mutate()
  }

  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">New Cloud Agent</span>
        </div>
        <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <form onSubmit={onSubmit} className="flex flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 scroll-thin">
          <Field label="名称（可选）" hint="留空 Cursor 会自动起一个">
            <input
              ref={nameRef}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="register-billing-fix"
            />
          </Field>

          <Field label="模型">
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {(models.data ?? [{ id: 'claude-4.6-sonnet', displayName: 'Claude 4.6 Sonnet' }]).map(
                (m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ),
              )}
            </select>
          </Field>

          <Field label="仓库 URL" hint="从已授权列表选，或粘贴一个">
            <input
              className="input"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/..."
              list="cursor-repos"
            />
            <datalist id="cursor-repos">
              {(repos.data?.items ?? []).map((r) => (
                <option key={r.url} value={r.url} />
              ))}
            </datalist>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="起始 ref">
              <input
                className="input"
                value={startingRef}
                onChange={(e) => setStartingRef(e.target.value)}
                placeholder="main"
              />
            </Field>
            <Field label="开 PR" hint="结束时自动开 pull request">
              <label className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm">
                <input
                  type="checkbox"
                  checked={autoCreatePR}
                  onChange={(e) => setAutoCreatePR(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[oklch(var(--accent-l)_var(--accent-c)_var(--accent-h))]"
                />
                <span className="text-ink-muted">auto PR</span>
              </label>
            </Field>
          </div>

          <Field
            label="环境变量 vault（可选）"
            hint={
              vaults.length === 0 ? (
                <span className="text-ink-dim">还没有 vault, 在 /vaults 创建后回来选</span>
              ) : (
                `${vaults.length} 个可选`
              )
            }
          >
            <select className="select" value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
              <option value="">— 不注入 envVars —</option>
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({Object.keys(v.envs).length} keys)
                </option>
              ))}
            </select>
          </Field>

          {!me.isLoading && !me.data?.apiKeyName && (
            <div
              className="rounded-md px-3 py-2 text-xs"
              style={{
                border: '1px solid oklch(var(--warn-l) var(--warn-c) var(--warn-h) / 0.42)',
                background: 'var(--warn-tint)',
                color: 'oklch(var(--warn-l) var(--warn-c) var(--warn-h))',
              }}
            >
              cursor-bridge 没看到 Cursor API Key, 去{' '}
              <a className="underline" href="/settings#bridges">
                Settings → Bridges
              </a>{' '}
              填一下。
            </div>
          )}

          {create.error && (
            <div
              className="rounded-md px-3 py-2 text-xs"
              style={{
                border: '1px solid oklch(var(--bad-l) var(--bad-c) var(--bad-h) / 0.42)',
                background: 'var(--bad-tint)',
                color: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h))',
              }}
            >
              {(create.error as Error).message}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3">
          <button type="button" onClick={onClose} className="btn">
            取消
          </button>
          <button type="submit" disabled={!canSubmit} className="btn btn-primary">
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建并打开
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          {label}
        </span>
        {hint && <span className="text-[10px] text-ink-dim">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

function KV({
  label,
  value,
  mono,
}: {
  label: string
  value: string | undefined
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-[0.04em] text-ink-dim">{label}</span>
      <span className={cn('truncate text-right text-xs text-ink', mono && 'font-mono')}>
        {value ?? '—'}
      </span>
    </div>
  )
}
