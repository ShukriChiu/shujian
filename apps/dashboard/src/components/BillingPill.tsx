import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronRight,
  CreditCard,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { cursorApi, type CursorUsage } from '@/lib/api'
import { useCredentials } from '@/lib/useCredentials'
import { cn } from '@/lib/utils'

const dollar = (cents?: number) =>
  cents == null ? '—' : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

interface Props {
  onOpenCredentials: () => void
}

export function BillingPill({ onOpenCredentials }: Props) {
  const creds = useCredentials()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  const usage = useQuery({
    queryKey: ['cursor', 'usage', creds.apiKey, creds.sessionToken],
    queryFn: cursorApi.usage,
    refetchInterval: 60_000,
    retry: 0,
    enabled: !!creds.apiKey || !!creds.sessionToken,
  })

  // — pill content —
  const noCreds = !creds.apiKey && !creds.sessionToken
  const data = usage.data

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2 text-[11px] transition hover:border-violet-300 hover:bg-violet-50/50',
          noCreds && 'border-amber-300 bg-amber-50/60 text-amber-800 hover:bg-amber-50',
        )}
      >
        {noCreds ? (
          <>
            <KeyRound className="h-3 w-3" />
            <span className="font-medium">设置凭证</span>
          </>
        ) : (
          <>
            <CreditCard className="h-3 w-3 text-violet-600" />
            <PillSummary data={data} loading={usage.isLoading} />
            <ChevronRight className={cn('h-3 w-3 text-ink-400 transition', open && 'rotate-90')} />
          </>
        )}
      </button>

      {open &&
        createPortal(
          <Popover
            anchor={ref.current}
            data={data}
            loading={usage.isLoading}
            fetching={usage.isFetching}
            onRefresh={() => usage.refetch()}
            onOpenCredentials={() => {
              setOpen(false)
              onOpenCredentials()
            }}
            onOutsideClose={() => setOpen(false)}
            hasSession={!!creds.sessionToken}
            hasApiKey={!!creds.apiKey}
          />,
          document.body,
        )}
    </div>
  )
}

function PillSummary({ data, loading }: { data?: CursorUsage; loading: boolean }) {
  if (loading) {
    return (
      <span className="flex items-center gap-1 text-ink-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        加载…
      </span>
    )
  }
  if (!data) return <span className="text-ink-500">用量</span>

  if (data.usage.available && data.usage.planLimitCents != null) {
    const used = data.usage.planUsedCents ?? 0
    const limit = data.usage.planLimitCents
    const pct = Math.min(100, (used / Math.max(1, limit)) * 100)
    const tone =
      pct > 90 ? 'text-red-700' : pct > 70 ? 'text-amber-700' : 'text-ink-800'
    return (
      <span className="flex items-center gap-1.5">
        <span className={cn('font-semibold', tone)}>{dollar(used)}</span>
        <span className="text-ink-400">/</span>
        <span className="text-ink-600">{dollar(limit)}</span>
        {data.plan.planName && <span className="text-ink-400">· {data.plan.planName}</span>}
      </span>
    )
  }
  if (data.usage.available && data.usage.planUsedCents != null) {
    return <span className="font-semibold text-ink-800">{dollar(data.usage.planUsedCents)}</span>
  }
  return (
    <span className="flex items-center gap-1 text-amber-700">
      <AlertTriangle className="h-3 w-3" />
      <span>无 session</span>
    </span>
  )
}

interface PopoverProps {
  anchor: HTMLElement | null
  data?: CursorUsage
  loading: boolean
  fetching: boolean
  onRefresh: () => void
  onOpenCredentials: () => void
  onOutsideClose: () => void
  hasSession: boolean
  hasApiKey: boolean
}

function Popover({ anchor, data, loading, fetching, onRefresh, onOpenCredentials, onOutsideClose, hasSession, hasApiKey }: PopoverProps) {
  const popRef = useRef<HTMLDivElement | null>(null)

  // — outside-click close (lives on the portal, anchored against both the
  //   anchor button and the popover body) —
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (anchor?.contains(t)) return
      onOutsideClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onOutsideClose])

  // Position relative to the anchor in viewport coords. Rendered via portal so
  // the parent header's backdrop-filter stacking context can't contain us.
  const rect = anchor?.getBoundingClientRect()
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 6, right: window.innerWidth - rect.right, zIndex: 9999 }
    : { position: 'fixed', top: 56, right: 16, zIndex: 9999 }

  return (
    <div
      ref={popRef}
      style={style}
      className="w-[340px] rounded-xl border border-ink-200 bg-white p-3 shadow-[0_16px_40px_-8px_rgba(15,23,42,0.25)]"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          <CreditCard className="h-3 w-3" />
          API Usage
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            className="rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            title="刷新"
          >
            <RefreshCw className={cn('h-3 w-3', fetching && 'animate-spin')} />
          </button>
          <button
            onClick={onOpenCredentials}
            className="rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            title="管理凭证"
          >
            <Settings2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          调取计费数据…
        </div>
      ) : (
        <div className="space-y-3">
          {data?.me && (
            <div className="flex items-start gap-2 rounded-lg border border-ink-100 bg-ink-50/40 px-2.5 py-2">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
                {(data.me.name || data.me.email || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-ink-900">
                  {data.me.name || data.me.email || data.me.apiKeyName || `user #${data.me.userId ?? ''}`}
                </div>
                {data.me.email && (
                  <div className="truncate text-[10px] text-ink-500">{data.me.email}</div>
                )}
              </div>
              {data.plan.planName && (
                <span className="pill pill-accent text-[9px] font-semibold uppercase tracking-wider">
                  {data.plan.planName}
                </span>
              )}
            </div>
          )}

          {data?.usage.available && data.usage.planLimitCents != null && (
            <UsageBar
              icon={<Sparkles className="h-3 w-3" />}
              label="本周期用量"
              used={data.usage.planUsedCents ?? 0}
              limit={data.usage.planLimitCents}
              extras={
                data.plan.billingCycleEnd
                  ? `下次重置 ${formatDate(data.plan.billingCycleEnd)}`
                  : undefined
              }
            />
          )}

          {data?.usage.available &&
            (data.usage.autoPercentUsed != null || data.usage.apiPercentUsed != null) && (
              <div className="space-y-2 rounded-lg border border-ink-100 bg-ink-50/30 p-2.5">
                <PercentBar
                  icon={<Wand2 className="h-3 w-3" />}
                  label="Auto + Composer"
                  pct={data.usage.autoPercentUsed ?? 0}
                  hint="composer-1 / auto"
                />
                <PercentBar
                  icon={<Sparkles className="h-3 w-3" />}
                  label="API (其他模型)"
                  pct={data.usage.apiPercentUsed ?? 0}
                  hint="claude / gpt / gemini …"
                />
              </div>
            )}

          {data && !data.usage.available && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
              <div className="flex items-start gap-2 text-[12px] text-amber-900">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium">还拿不到用量</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-amber-800">
                    {data.usage.reason ?? '需要 session token'}
                  </div>
                </div>
              </div>
              <button
                onClick={onOpenCredentials}
                className="mt-2 w-full rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-50"
              >
                {hasSession ? '重新粘 session token →' : '粘贴 session token →'}
              </button>
            </div>
          )}

          {!hasApiKey && !hasSession && (
            <div className="rounded-lg border border-ink-200 bg-ink-50 p-2.5 text-[11px] text-ink-600">
              未设置任何凭证。点右上 <kbd className="rounded bg-white px-1 py-0.5 font-mono text-[10px]">Settings</kbd> 配置。
            </div>
          )}

          <div className="flex items-center justify-between border-t border-ink-100 pt-2 text-[10px] text-ink-400">
            <span>
              source: <span className="font-mono">{data?.source ?? '—'}</span>
            </span>
            <a
              href="https://cursor.com/dashboard/usage"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 text-violet-700 hover:underline"
            >
              dashboard
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

function UsageBar({
  icon,
  label,
  used,
  limit,
  extras,
}: {
  icon: React.ReactNode
  label: string
  used: number
  limit: number
  extras?: string
}) {
  const pct = Math.min(100, (used / Math.max(1, limit)) * 100)
  const danger = pct > 90
  const warn = pct > 70 && !danger
  const colorClass = danger
    ? 'bg-red-500'
    : warn
      ? 'bg-amber-500'
      : 'bg-gradient-to-r from-violet-500 to-indigo-500'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-1 text-ink-700">
          <span className="text-ink-500">{icon}</span>
          <span className="truncate">{label}</span>
        </div>
        <div className="font-mono text-[11px] font-semibold text-ink-900">
          {dollar(used)} <span className="text-ink-400">/ {dollar(limit)}</span>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-100">
        <div
          className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[10px] text-ink-500">
        <span>{pct.toFixed(1)}% used</span>
        {extras && <span>{extras}</span>}
      </div>
    </div>
  )
}

// Percent-only bar — Cursor exposes Auto vs API split as percentages of
// each bucket, but doesn't surface per-bucket dollar limits. So we render
// just the percent.
function PercentBar({
  icon,
  label,
  pct,
  hint,
}: {
  icon: React.ReactNode
  label: string
  pct: number
  hint?: string
}) {
  const clamped = Math.min(100, Math.max(0, pct))
  const danger = clamped > 90
  const warn = clamped > 70 && !danger
  const colorClass = danger
    ? 'bg-red-500'
    : warn
      ? 'bg-amber-500'
      : 'bg-gradient-to-r from-violet-500 to-indigo-500'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5 text-ink-700">
          <span className="text-ink-500">{icon}</span>
          <span className="truncate font-medium">{label}</span>
          {hint && <span className="truncate text-[10px] text-ink-400">{hint}</span>}
        </div>
        <span className="font-mono text-[11px] font-semibold text-ink-900">
          {clamped.toFixed(0)}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink-100">
        <div
          className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
