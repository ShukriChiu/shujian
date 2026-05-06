import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { cursorApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

export function BillingView() {
  const usage = useQuery({
    queryKey: ['cursor', 'usage'],
    queryFn: cursorApi.usage,
    retry: 0,
    refetchInterval: 30_000,
  })

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Billing"
        description="Cursor 计费窗口与本月用量。数据来自 cursor-bridge 的 /usage（需要 SessionToken）。"
        actions={
          <a
            href="https://cursor.com/settings"
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 打开 cursor.com
          </a>
        }
      />
      <div className="px-6 pb-12">
        {usage.isLoading ? (
          <div className="flex items-center gap-2 px-6 py-12 text-sm text-ink-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> 拉取计费数据
          </div>
        ) : !usage.data || !usage.data.usage.available ? (
          <EmptyState
            title="计费数据未连接"
            hint={
              <>
                cursor-bridge 没看到 SessionToken (来自{' '}
                <span className="text-ink-muted">cursor.com</span> 的{' '}
                <span className="text-ink-muted">WorkosCursorSessionToken</span> cookie)。
                <br />
                去 Settings → Bridges 填上后就能看到 plan / usage / 剩余 quota。
              </>
            }
            action={
              <a href="/settings" className="btn btn-primary">
                打开 Settings
              </a>
            }
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <UsagePanel
              title="Composer"
              hint="Auto + Composer 模式"
              percent={usage.data.usage.autoPercentUsed ?? 0}
              message={usage.data.usage.autoMessage}
            />
            <UsagePanel
              title="API"
              hint="其他模型 (gpt-5, claude, etc.)"
              percent={usage.data.usage.apiPercentUsed ?? 0}
              message={usage.data.usage.apiMessage}
            />
            <PlanPanel
              plan={usage.data.plan}
              fetchedAt={usage.data.fetchedAt}
              source={usage.data.source}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function UsagePanel({
  title,
  hint,
  percent,
  message,
}: {
  title: string
  hint: string
  percent: number
  message?: string
}) {
  const p = Math.max(0, Math.min(100, percent))
  const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'
  return (
    <section className="panel p-5">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          <p className="text-xs text-ink-dim">{hint}</p>
        </div>
        <span className={cn('font-mono text-2xl font-semibold tabular-nums', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink')}>
          {p.toFixed(1)}%
        </span>
      </header>
      <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            'h-full transition-[width] duration-500',
            tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-accent',
          )}
          style={{ width: `${p}%` }}
        />
      </div>
      {message && (
        <p className="mt-3 font-mono text-[11px] text-ink-dim">{message}</p>
      )}
    </section>
  )
}

function PlanPanel({
  plan,
  fetchedAt,
  source,
}: {
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
  fetchedAt: string
  source: string
}) {
  return (
    <section className="panel p-5 lg:col-span-2">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">Plan</h2>
          <p className="text-xs text-ink-dim">订阅与计费窗口</p>
        </div>
        <span className="pill pill-muted font-mono">via {source}</span>
      </header>
      {!plan.available ? (
        <p className="mt-4 text-sm text-ink-dim">{plan.reason ?? '无 plan 数据'}</p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          <Item label="Plan">{plan.planName ?? plan.membershipType ?? '—'}</Item>
          <Item label="Price">{plan.price ?? '—'}</Item>
          <Item label="Included">
            {plan.includedAmountCents ? `$${(plan.includedAmountCents / 100).toFixed(0)}` : '—'}
          </Item>
          <Item label="Hard limit">
            {plan.hardLimitDollars != null ? `$${plan.hardLimitDollars}` : '—'}
          </Item>
          <Item label="Cycle start">
            {plan.billingCycleStart
              ? new Date(plan.billingCycleStart).toLocaleDateString('zh-CN')
              : '—'}
          </Item>
          <Item label="Cycle end">
            {plan.billingCycleEnd
              ? new Date(plan.billingCycleEnd).toLocaleDateString('zh-CN')
              : '—'}
          </Item>
          <Item label="Fetched">
            {new Date(fetchedAt).toLocaleString('zh-CN', { hour12: false })}
          </Item>
        </dl>
      )}
    </section>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.04em] text-ink-dim">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-ink">{children}</dd>
    </div>
  )
}
