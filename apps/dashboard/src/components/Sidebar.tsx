import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import {
  Activity,
  Bot,
  CalendarClock,
  ChevronsUpDown,
  Command,
  CreditCard,
  KeyRound,
  ListChecks,
  Search,
  ScrollText,
  Settings,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { cn } from '@/lib/utils'
import { Wordmark } from './Logomark'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  end?: boolean
  shortcut?: string
}

const PRIMARY: NavItem[] = [
  { to: '/agents', label: 'Agents', icon: Bot, shortcut: 'G A' },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock, shortcut: 'G S' },
  { to: '/audit-log', label: 'Audit log', icon: ScrollText, shortcut: 'G L' },
]

const SECONDARY: NavItem[] = [
  { to: '/vaults', label: 'Vaults', icon: KeyRound },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar({
  onOpenCommand,
  mobileOpen = false,
  onMobileClose,
}: {
  onOpenCommand: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
}) {
  const auth = useAuth()
  return (
    <aside
      className={cn(
        'flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-surface',
        'fixed inset-y-0 left-0 z-40 transform transition-transform duration-300 ease-out-quart',
        'lg:relative lg:w-[var(--sidebar-w)] lg:translate-x-0 lg:transition-none',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
      )}
      aria-label="Primary navigation"
    >
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-3.5">
        <Link to="/agents" className="rounded-md px-1 py-1 hover:bg-surface-2">
          <Wordmark />
        </Link>
        <button
          type="button"
          onClick={onMobileClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-dim hover:bg-surface-2 hover:text-ink lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <WorkspaceSwitcher />

      <button
        onClick={onOpenCommand}
        className="mx-3 mt-2 flex h-8 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-sm text-ink-dim transition-colors hover:bg-surface-3 hover:text-ink-muted"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Jump to</span>
        <span className="kbd">⌘</span>
        <span className="kbd">K</span>
      </button>

      <nav className="mt-4 flex-1 px-3 pb-3">
        <NavSection label="Operate" items={PRIMARY} />
        <div className="mt-5">
          <NavSection label="Configure" items={SECONDARY} />
        </div>
      </nav>

      {auth.user && (
        <div className="border-t border-line px-3 py-3">
          <UserPill identifier={auth.user.identifier} display={auth.user.display_name} />
        </div>
      )}
    </aside>
  )
}

function NavSection({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <div>
      <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        {label}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} className="nav-item">
              <item.icon className="nav-glyph" />
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="hidden font-mono text-[10px] text-ink-dim sm:inline">
                  {item.shortcut}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

function WorkspaceSwitcher() {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!auth.tenant) {
    return (
      <div className="mx-3 mt-3 h-9 rounded-md border border-line bg-surface-2 px-2.5 text-xs leading-9 text-ink-dim">
        加载工作区
      </div>
    )
  }

  const tenant = auth.tenant
  const others = auth.tenants.filter((t) => t.id !== tenant.id)

  return (
    <div ref={ref} className="relative mx-3 mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-left transition-colors',
          'hover:bg-surface-3',
          open && 'bg-surface-3',
        )}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold uppercase text-ink-inv"
          style={{ background: 'oklch(var(--accent-l) var(--accent-c) var(--accent-h))' }}
        >
          {tenant.slug.slice(0, 1)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-none">
          <span className="truncate font-mono text-[12px] text-ink">{tenant.slug}</span>
          {tenant.role && (
            <span className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-dim">
              {tenant.role}
            </span>
          )}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-ink-dim" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 origin-top animate-fade-up rounded-md border border-line-strong bg-surface-2 py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)]">
          <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
            Workspace
          </div>
          <button
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-3"
            disabled
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold uppercase text-ink-inv"
              style={{ background: 'oklch(var(--accent-l) var(--accent-c) var(--accent-h))' }}
            >
              {tenant.slug.slice(0, 1)}
            </span>
            <span className="flex flex-1 flex-col">
              <span className="font-mono text-[12px] text-ink">{tenant.slug}</span>
              <span className="text-[10px] text-ink-dim">{tenant.name}</span>
            </span>
            <span className="text-accent" aria-hidden>
              ●
            </span>
          </button>
          {others.length > 0 && (
            <>
              <div className="mx-2 my-1 h-px bg-line" />
              {others.map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-3"
                  onClick={() => {
                    auth.switchTenant(t.id)
                    setOpen(false)
                  }}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-3 text-[11px] font-semibold uppercase text-ink-muted">
                    {t.slug.slice(0, 1)}
                  </span>
                  <span className="flex flex-1 flex-col">
                    <span className="font-mono text-[12px] text-ink">{t.slug}</span>
                    <span className="text-[10px] text-ink-dim">{t.name}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function UserPill({ identifier, display }: { identifier: string; display: string | null }) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink">
          {(display ?? identifier).slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm text-ink">{display ?? identifier}</span>
          <span className="truncate text-[11px] text-ink-dim">{identifier}</span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-ink-dim" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 origin-bottom animate-fade-up rounded-md border border-line-strong bg-surface-2 py-1">
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Settings
          </Link>
          <Link
            to="/audit-log"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Activity
          </Link>
          <div className="my-1 h-px bg-line" />
          <button
            onClick={() => auth.logout()}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <Activity className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function CurrentRouteHint() {
  const loc = useLocation()
  const seg = loc.pathname.split('/').filter(Boolean)[0] ?? 'agents'
  return (
    <span className="font-mono text-xs text-ink-dim">
      <Command className="mr-1 inline h-3 w-3" />
      {seg}
    </span>
  )
}
