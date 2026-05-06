import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, CalendarClock, CheckCircle2, ListTodo, XCircle } from 'lucide-react'
import { agentApi, cursorApi } from '@/lib/api'
import { Panel, ErrorBanner, EmptyState } from '@/components/Panel'
import { formatDuration } from '@/lib/utils'

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'ok' | 'bad' | 'accent'
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-red-700'
        : tone === 'accent'
          ? 'text-violet-700'
          : 'text-ink-900'
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div>}
    </div>
  )
}

export function OverviewView() {
  const status = useQuery({
    queryKey: ['agent', 'status'],
    queryFn: agentApi.status,
    refetchInterval: 4_000,
  })
  const triggers = useQuery({ queryKey: ['agent', 'triggers'], queryFn: agentApi.triggers })
  const cursorList = useQuery({
    queryKey: ['cursor', 'list'],
    queryFn: cursorApi.list,
    retry: 0,
    refetchInterval: 6_000,
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="运行时长"
          value={status.data ? formatDuration(status.data.uptime_secs) : '—'}
          hint="自 daemon 启动起算"
        />
        <Stat
          label="进行中任务"
          value={status.data?.active_tasks.length ?? 0}
          hint={status.data ? `并发上限 ${status.data.max_concurrent}` : '未连接'}
          tone="accent"
        />
        <Stat
          label="已完成"
          value={status.data?.tasks_completed ?? 0}
          hint="本会话累计"
          tone="ok"
        />
        <Stat
          label="失败"
          value={status.data?.tasks_failed ?? 0}
          hint="非 0 时建议查 daemon 日志"
          tone={status.data?.tasks_failed ? 'bad' : 'default'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel
          title="进行中"
          sub="shujian-agent 当前活跃任务"
          className="lg:col-span-2"
          actions={
            <span className="pill pill-muted">
              <ListTodo className="h-3 w-3" /> {status.data?.active_tasks.length ?? 0}
            </span>
          }
        >
          {status.error ? (
            <ErrorBanner error={status.error} />
          ) : status.data?.active_tasks.length ? (
            <div className="divide-y divide-ink-100">
              {status.data.active_tasks.map((t) => (
                <div key={t.id} className="row grid-cols-12">
                  <div className="col-span-2 font-mono text-[11px] text-ink-500">{t.id}</div>
                  <div className="col-span-3 font-medium text-ink-800">{t.agent}</div>
                  <div className="col-span-5 truncate text-ink-700">{t.message}</div>
                  <div className="col-span-2 text-right text-ink-500">{t.started_at}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="当前无活跃任务" hint="触发器到点或手动派单后会出现在这里。" />
          )}
        </Panel>

        <Panel
          title="计划触发器"
          sub="cron / interval"
          actions={
            <span className="pill pill-muted">
              <CalendarClock className="h-3 w-3" /> {triggers.data?.length ?? 0}
            </span>
          }
        >
          {triggers.error ? (
            <ErrorBanner error={triggers.error} />
          ) : Array.isArray(triggers.data) && triggers.data.length ? (
            <div className="divide-y divide-ink-100">
              {triggers.data.map((t) => (
                <div key={t.name} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-ink-800">{t.name}</div>
                    <span className="pill pill-info">
                      {t.trigger_type === 'cron' ? t.expr : `${t.minutes ?? '?'}m`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-500">→ {t.agent ?? 'default'}</div>
                  <div className="mt-1 text-ink-600">{t.reason}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="尚无触发器" hint="在 config.toml 里加 [[triggers]]。" />
          )}
        </Panel>
      </div>

      <Panel
        title="Cursor Agents"
        sub="通过 @cursor/sdk 创建的本地 / 云端 agents"
        actions={
          <a className="btn h-7 text-[11px]" href="#" onClick={(e) => e.preventDefault()}>
            <ArrowUpRight className="h-3 w-3" />
            前往 Cursor 标签
          </a>
        }
      >
        {cursorList.error ? (
          <div className="px-5 py-4 text-xs text-ink-500">
            cursor-bridge 未就绪 ·{' '}
            <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px]">
              cd shujian-agent/cursor-bridge && bun run dev
            </code>
          </div>
        ) : cursorList.data?.items.length ? (
          <div className="divide-y divide-ink-100">
            {cursorList.data.items.map((a) => (
              <div key={a.agentId} className="row grid-cols-12">
                <div className="col-span-7 truncate font-mono text-[11px] text-ink-700">
                  {a.agentId}
                </div>
                <div className="col-span-3 text-ink-600">{a.model?.id ?? '—'}</div>
                <div className="col-span-2 text-right">
                  {a.agentId.startsWith('bc-') ? (
                    <span className="pill pill-accent">cloud</span>
                  ) : (
                    <span className="pill pill-info">local</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="尚无活跃 Cursor agent"
            hint="去「Cursor Agents」标签新建一个 local 或 cloud agent。"
          />
        )}
      </Panel>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            最佳实践
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-600">
            <li>把高频 + 高确定性的活塞进 Rust 本地 agent，模型用 quick_ops。</li>
            <li>需要直接动 Cursor IDE / 仓库的事，用 Cursor agent，本地或云端。</li>
            <li>CURSOR_API_KEY 走 cursor-bridge 的 .env，不要塞进 dashboard。</li>
          </ul>
        </div>
        <div className="panel p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <XCircle className="h-4 w-4 text-red-500" />
            常见误区
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-600">
            <li>不要在 Rust 端直接 spawn cursor-agent CLI — 调 cursor-bridge 拿 SSE 更顺。</li>
            <li>云端 Cursor agent 会创建 PR，注意挑对 repo 和 startingRef。</li>
            <li>本地 agent 的 cwd 要传绝对路径，相对路径会以 bridge 进程的 cwd 为基准。</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
