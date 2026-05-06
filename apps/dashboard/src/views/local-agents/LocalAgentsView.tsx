import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, Wand2 } from 'lucide-react'
import { agentApi, ApiError, type AgentDto } from '@/lib/api'
import { Panel, ErrorBanner, EmptyState } from '@/components/Panel'
import { cn } from '@/lib/utils'

function AgentCard({
  agent,
  active,
  onSelect,
}: {
  agent: AgentDto
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition',
        active
          ? 'border-violet-300 bg-violet-50/60 shadow-sm'
          : 'border-ink-200 bg-white hover:border-ink-300',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-ink-900">{agent.name}</div>
        {agent.model_category && (
          <span className="pill pill-muted">{agent.model_category}</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-ink-500 line-clamp-2">
        {agent.description ?? '— 无描述 —'}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-500">
        <span className="font-mono">{agent.effective_model.split(':')[0]}</span>
        <span className="text-ink-300">·</span>
        <span>{agent.effective_provider}</span>
        {agent.tools && (
          <>
            <span className="text-ink-300">·</span>
            <span>{agent.tools.length} tools</span>
          </>
        )}
      </div>
    </button>
  )
}

interface RunResult {
  ok: boolean
  text: string
  durationMs: number
}

export function LocalAgentsView() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [context, setContext] = useState('')
  const [results, setResults] = useState<Array<{ id: string; agent: string; message: string } & RunResult>>([])

  const agents = useQuery({ queryKey: ['agent', 'agents'], queryFn: agentApi.agents })

  const run = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now()
      const res = await agentApi.runTaskSync({
        agent: selected ?? undefined,
        message,
        context: context.trim() || undefined,
      })
      const durationMs = Math.round(performance.now() - startedAt)
      return { ...res, durationMs }
    },
    onSuccess: (res) => {
      setResults((prev) => [
        {
          id: crypto.randomUUID().slice(0, 8),
          agent: selected ?? 'default',
          message,
          ok: res.success,
          text: res.result,
          durationMs: res.durationMs,
        },
        ...prev,
      ].slice(0, 12))
      setMessage('')
      qc.invalidateQueries({ queryKey: ['agent', 'status'] })
    },
  })

  const activeAgent = agents.data?.find((a) => a.name === selected) ?? agents.data?.[0]
  const effectiveSelected = selected ?? activeAgent?.name ?? null

  if (agents.error) return <ErrorBanner error={agents.error} />

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <Panel
        title="数字员工"
        sub={agents.data ? `${agents.data.length} 个本地 agent` : '加载中…'}
        bodyClassName="p-3"
      >
        {agents.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-ink-500">
            <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
          </div>
        ) : Array.isArray(agents.data) && agents.data.length ? (
          <div className="space-y-2">
            {agents.data.map((a) => (
              <AgentCard
                key={a.name}
                agent={a}
                active={a.name === effectiveSelected}
                onSelect={() => setSelected(a.name)}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="config.toml 里没配 agent" />
        )}
      </Panel>

      <div className="space-y-5">
        <Panel
          title={activeAgent ? `派单 → ${activeAgent.name}` : '派单'}
          sub={activeAgent?.description ?? '选一个 agent 后开始派单'}
          actions={
            activeAgent && (
              <span className="pill pill-accent">
                {activeAgent.effective_model.split(':')[0]}
              </span>
            )
          }
          bodyClassName="space-y-3 p-5"
        >
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-500">
              任务描述
            </label>
            <textarea
              className="textarea h-24"
              placeholder="给数字员工的指令，比如：扫描今天新入库的证照并提取关键字段"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-500">
              附加上下文（可选）
            </label>
            <textarea
              className="textarea h-16 font-mono"
              placeholder="JSON / Markdown / 任意补充信息"
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-ink-500">
              使用 <code className="rounded bg-ink-100 px-1 text-[10px]">/api/task/sync</code> · 同步等结果
            </div>
            <button
              className="btn btn-primary"
              disabled={!message.trim() || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              {run.isPending ? '执行中…' : '派单'}
            </button>
          </div>
          {run.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {(run.error as ApiError).message}
            </div>
          )}
        </Panel>

        <Panel
          title="最近结果"
          sub="同会话内的派单回执"
          actions={
            results.length > 0 && (
              <button className="btn btn-ghost h-7 text-[11px]" onClick={() => setResults([])}>
                清空
              </button>
            )
          }
        >
          {results.length === 0 ? (
            <EmptyState
              title="还没有结果"
              hint="派单成功后会按时间倒序出现在这里。"
              action={
                <span className="pill pill-muted">
                  <Wand2 className="h-3 w-3" /> 试试上面的派单框
                </span>
              }
            />
          ) : (
            <div className="divide-y divide-ink-100">
              {results.map((r) => (
                <div key={r.id} className="space-y-2 px-5 py-3">
                  <div className="flex items-center justify-between text-[11px] text-ink-500">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{r.id}</span>
                      <span className="text-ink-300">·</span>
                      <span className="font-medium text-ink-700">{r.agent}</span>
                      <span className="text-ink-300">·</span>
                      <span>{(r.durationMs / 1000).toFixed(2)}s</span>
                    </div>
                    {r.ok ? (
                      <span className="pill pill-ok">OK</span>
                    ) : (
                      <span className="pill pill-bad">FAILED</span>
                    )}
                  </div>
                  <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-700">{r.message}</div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-ink-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-ink-700 scroll-thin">
                    {r.text || '(空响应)'}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
