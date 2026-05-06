import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bot,
  CalendarClock,
  CreditCard,
  KeyRound,
  ScrollText,
  Search,
  Settings,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Action {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  run: () => void
  keywords?: string
}

export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const actions: Action[] = useMemo(
    () => [
      {
        id: 'agents',
        label: 'Agents',
        hint: 'Local + cloud runs',
        icon: Bot,
        run: () => nav('/agents'),
        keywords: 'tasks runs cursor',
      },
      {
        id: 'schedules',
        label: 'Schedules',
        hint: 'Cron triggers',
        icon: CalendarClock,
        run: () => nav('/schedules'),
        keywords: 'cron trigger',
      },
      {
        id: 'audit',
        label: 'Audit log',
        hint: 'Recent actions',
        icon: ScrollText,
        run: () => nav('/audit-log'),
        keywords: 'history events',
      },
      {
        id: 'vaults',
        label: 'Vaults',
        hint: 'Env credential bundles',
        icon: KeyRound,
        run: () => nav('/vaults'),
        keywords: 'env secrets credentials',
      },
      {
        id: 'billing',
        label: 'Billing',
        hint: 'Cursor usage',
        icon: CreditCard,
        run: () => nav('/billing'),
        keywords: 'usage plan composer api',
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Bridges, account',
        icon: Settings,
        run: () => nav('/settings'),
        keywords: 'bridge account theme',
      },
      {
        id: 'preferences',
        label: 'Preferences',
        hint: 'Theme, density',
        icon: SlidersHorizontal,
        run: () => nav('/settings/preferences'),
        keywords: 'theme dark light',
      },
    ],
    [nav],
  )

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return actions
    return actions.filter((a) =>
      [a.label, a.hint, a.keywords].filter(Boolean).join(' ').toLowerCase().includes(term),
    )
  }, [q, actions])

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (active >= filtered.length) setActive(0)
  }, [filtered, active])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 px-4 pt-[10vh] backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-[560px] origin-top animate-fade-up overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_24px_48px_-16px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-2 border-b border-line px-3.5">
          <Search className="h-4 w-4 text-ink-dim" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="跳转或操作"
            className="h-12 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-dim"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => (i + 1) % Math.max(1, filtered.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive(
                  (i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length),
                )
              } else if (e.key === 'Enter') {
                const item = filtered[active]
                if (item) {
                  item.run()
                  onClose()
                }
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <ul className="max-h-[320px] overflow-y-auto py-1.5 scroll-thin">
          {filtered.length === 0 && (
            <li className="px-3.5 py-3 text-sm text-ink-dim">没有匹配项</li>
          )}
          {filtered.map((a, i) => {
            const Icon = a.icon
            const isActive = i === active
            return (
              <li
                key={a.id}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  a.run()
                  onClose()
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 px-3.5 py-2 text-sm',
                  isActive ? 'bg-surface-3 text-ink' : 'text-ink-muted',
                )}
              >
                <Icon className={cn('h-4 w-4', isActive ? 'text-accent' : 'text-ink-dim')} />
                <span className="flex-1">{a.label}</span>
                {a.hint && <span className="text-[11px] text-ink-dim">{a.hint}</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
