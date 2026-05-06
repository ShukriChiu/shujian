import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Globe2, Plug, Plus, Server } from 'lucide-react'
import { LOCAL_ENDPOINT, setActiveBridge } from '@/lib/bridges'
import { useActiveBridge, useBridges } from '@/lib/useBridges'
import { cursorApi } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  onOpenManager: () => void
}

export function BridgePill({ onOpenManager }: Props) {
  const active = useActiveBridge()
  const bridges = useBridges()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  const health = useQuery({
    queryKey: ['cursor', 'health', active.id, active.endpoint],
    queryFn: cursorApi.health,
    refetchInterval: 12_000,
    retry: 0,
  })

  useEffect(() => {
    if (!open) return
    const onClickAway = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchor.current && !anchor.current.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onClickAway)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClickAway)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open && anchor.current) {
      const r = anchor.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
  }, [open, bridges.length])

  function pick(id: string) {
    setActiveBridge(id)
    qc.invalidateQueries({ queryKey: ['cursor'] })
    setOpen(false)
  }

  const ok = health.data?.ok === true
  const remote = active.endpoint !== LOCAL_ENDPOINT

  return (
    <>
      <button
        ref={anchor}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border bg-white px-2 text-[11px] transition hover:border-violet-300 hover:bg-violet-50/50',
          ok ? 'border-ink-200' : 'border-amber-300 bg-amber-50/40',
        )}
      >
        {remote ? (
          <Globe2 className="h-3 w-3 text-violet-600" />
        ) : (
          <Plug className="h-3 w-3 text-emerald-600" />
        )}
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            ok ? 'bg-emerald-500 animate-pulse-soft' : 'bg-red-500',
          )}
        />
        <span className="font-medium text-ink-800">{active.name}</span>
        {health.data && (
          <span className="text-ink-500">
            · {health.data.activeAgents ?? 0}A · {health.data.activeRuns ?? 0}R
          </span>
        )}
        <ChevronDown className="h-3 w-3 text-ink-400" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 1000 }}
            className="w-[280px] rounded-xl border border-ink-200 bg-white shadow-2xl"
          >
            <div className="border-b border-ink-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              切换 Bridge
            </div>
            <ul className="max-h-[260px] overflow-auto p-1">
              {bridges.map((b) => {
                const isActive = b.id === active.id
                return (
                  <li key={b.id}>
                    <button
                      onClick={() => pick(b.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-violet-50',
                        isActive && 'bg-violet-50',
                      )}
                    >
                      {b.endpoint === LOCAL_ENDPOINT ? (
                        <Plug className="h-3 w-3 shrink-0 text-emerald-600" />
                      ) : (
                        <Globe2 className="h-3 w-3 shrink-0 text-violet-600" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-ink-900">{b.name}</div>
                        <div className="truncate font-mono text-[10px] text-ink-500">{b.endpoint}</div>
                      </div>
                      {isActive && <Check className="h-3 w-3 text-violet-700" />}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex items-center gap-1 border-t border-ink-100 p-1.5">
              <button
                onClick={() => {
                  setOpen(false)
                  onOpenManager()
                }}
                className="btn btn-ghost h-7 flex-1 text-[11px]"
              >
                <Server className="h-3 w-3" />
                管理
              </button>
              <button
                onClick={() => {
                  setOpen(false)
                  onOpenManager()
                }}
                className="btn btn-ghost h-7 px-2 text-[11px]"
                title="新增 bridge"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
