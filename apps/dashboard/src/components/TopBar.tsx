import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleDot, Plug, Settings2 } from 'lucide-react'
import { agentApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BillingPill } from './BillingPill'
import { BridgePill } from './BridgePill'
import { BridgesDialog } from './BridgesDialog'
import { CredentialsDialog } from './CredentialsDialog'

function StatusDot({ ok, label, sub }: { ok: boolean; label: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-white px-2.5 py-1">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          ok ? 'bg-emerald-500 animate-pulse-soft' : 'bg-red-500',
        )}
      />
      <div className="leading-tight">
        <div className="text-[11px] font-medium text-ink-700">{label}</div>
        {sub && <div className="text-[10px] text-ink-500">{sub}</div>}
      </div>
    </div>
  )
}

export function TopBar() {
  const [credsOpen, setCredsOpen] = useState(false)
  const [bridgesOpen, setBridgesOpen] = useState(false)
  const health = useQuery({
    queryKey: ['agent', 'health'],
    queryFn: agentApi.health,
    refetchInterval: 8_000,
  })

  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-200/70 bg-white/80 px-5 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-sm">
            <CircleDot className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight text-ink-900">
              Shujian · Agent Console
            </div>
            <div className="text-[11px] text-ink-500">
              本地 Rust runtime + N×Cursor bridge — 一屏管完
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot
            ok={health.data?.status === 'ok'}
            label="shujian-agent"
            sub={health.data ? `${health.data.agents.length} agents · v${health.data.version}` : '断开'}
          />
          <BridgePill onOpenManager={() => setBridgesOpen(true)} />
          <BillingPill onOpenCredentials={() => setCredsOpen(true)} />
          <button
            className="btn btn-ghost h-7 px-2 text-[11px]"
            onClick={() => setCredsOpen(true)}
            title="当前 bridge 凭证"
          >
            <Settings2 className="h-3 w-3" />
          </button>
          <button
            className="btn btn-ghost h-7 px-2 text-[11px]"
            onClick={() => window.location.reload()}
            title="重新加载"
          >
            <Plug className="h-3 w-3" />
            刷新
          </button>
        </div>
      </header>
      <CredentialsDialog open={credsOpen} onClose={() => setCredsOpen(false)} />
      <BridgesDialog open={bridgesOpen} onClose={() => setBridgesOpen(false)} />
    </>
  )
}
