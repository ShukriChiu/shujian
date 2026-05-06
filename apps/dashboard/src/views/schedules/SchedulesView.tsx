import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Loader2 } from 'lucide-react'
import { agentApi, type TriggerDto } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

export function SchedulesView() {
  const triggers = useQuery({
    queryKey: ['agent', 'triggers'],
    queryFn: agentApi.triggers,
    retry: 0,
  })

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Schedules"
        description="cron 触发器。来源：shujian-agent 的 config.toml [[triggers]] 表。"
        meta={triggers.data ? <span className="font-mono">{triggers.data.length} triggers</span> : undefined}
      />
      <div className="px-6 pb-12">
        {triggers.isLoading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-ink-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> 拉取触发器
          </div>
        ) : triggers.error ? (
          <EmptyState
            glyph={<CalendarClock className="h-5 w-5" />}
            title="触发器拉不到"
            hint={
              <>
                shujian-agent 看起来没在 :8002 跑。
                <br />
                <span className="text-ink-muted">just dev-agent</span> 启动后再回来。
              </>
            }
          />
        ) : triggers.data && triggers.data.length > 0 ? (
          <TriggersList triggers={triggers.data} />
        ) : (
          <EmptyState
            glyph={<CalendarClock className="h-5 w-5" />}
            title="还没有触发器"
            hint={
              <>
                在{' '}
                <code className="font-mono text-ink-muted">shujian-agent/config.toml</code>{' '}
                里加 <code className="font-mono text-ink-muted">[[triggers]]</code> 段, 类似:
                <br />
                <code className="block whitespace-pre py-2 text-left text-ink-muted">
                  {`[[triggers]]
name = "nightly-cleanup"
trigger_type = "cron"
expr = "0 3 * * *"
agent = "cleanup"`}
                </code>
              </>
            }
          />
        )}
      </div>
    </div>
  )
}

function TriggersList({ triggers }: { triggers: TriggerDto[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {triggers.map((t) => (
        <li
          key={`${t.name}-${t.trigger_type}`}
          className="grid grid-cols-[16px_minmax(0,1.4fr)_120px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-3 px-6 py-3 text-sm hover:bg-surface-2"
        >
          <CalendarClock className="h-3.5 w-3.5 text-ink-dim" />
          <span className="truncate font-medium text-ink">{t.name}</span>
          <span
            className={cn(
              'pill',
              t.trigger_type === 'cron' ? 'pill-info' : 'pill-muted',
            )}
          >
            {t.trigger_type}
          </span>
          <span className="truncate font-mono text-xs text-ink-muted">
            {t.expr ?? (t.minutes != null ? `every ${t.minutes}m` : '—')}
          </span>
          <span className="truncate font-mono text-xs text-ink-dim">
            {t.agent ?? 'default'} · {t.reason}
          </span>
        </li>
      ))}
    </ul>
  )
}
