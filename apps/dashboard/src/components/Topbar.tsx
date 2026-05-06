import { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Menu, Sun, Moon, Plug, Search } from 'lucide-react'
import { agentApi, cursorApi } from '@/lib/api'
import { cn } from '@/lib/utils'

const SEGMENT_LABEL: Record<string, string> = {
  agents: 'Agents',
  vaults: 'Vaults',
  schedules: 'Schedules',
  'audit-log': 'Audit log',
  billing: 'Billing',
  settings: 'Settings',
}

export function Topbar({
  onOpenCommand,
  onOpenNav,
}: {
  onOpenCommand: () => void
  onOpenNav: () => void
}) {
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center justify-between border-b border-line bg-bg/80 pl-3 pr-3 backdrop-blur lg:pl-6 lg:pr-4">
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onOpenNav}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
          aria-label="Open navigation"
        >
          <Menu className="h-4 w-4" />
        </button>
        <Breadcrumbs />
      </div>
      <div className="flex items-center gap-2">
        <RuntimeIndicator />
        <UsageIndicator />
        <button
          onClick={onOpenCommand}
          className="hidden h-7 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 text-xs text-ink-dim hover:bg-surface-3 md:inline-flex"
          title="Search & jump"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="kbd">⌘</span>
          <span className="kbd">K</span>
        </button>
        <ThemeToggle />
      </div>
    </header>
  )
}

function Breadcrumbs() {
  const loc = useLocation()
  const [params] = useSearchParams()
  const segs = loc.pathname.split('/').filter(Boolean)
  const root = segs[0] ?? 'agents'
  const selectedId = params.get('id')
  return (
    <nav className="flex items-center gap-2 text-sm" aria-label="Breadcrumb">
      <Link to={`/${root}`} className="text-ink hover:text-accent">
        {SEGMENT_LABEL[root] ?? root}
      </Link>
      {selectedId && root === 'agents' && (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-ink-dim" />
          <span className="font-mono text-xs text-ink-muted">{selectedId.slice(0, 28)}</span>
        </>
      )}
    </nav>
  )
}

function RuntimeIndicator() {
  const health = useQuery({
    queryKey: ['agent', 'health'],
    queryFn: agentApi.health,
    refetchInterval: 8_000,
    retry: 0,
  })
  const ok = health.data?.status === 'ok'
  return (
    <span
      className={cn('pill', ok ? 'pill-ok' : 'pill-muted')}
      title={
        ok
          ? `${health.data?.agents.length ?? 0} agents · v${health.data?.version}`
          : 'shujian-agent offline'
      }
    >
      <span className={cn('dot', ok ? 'dot-ok' : 'dot-idle')} />
      <span className="font-mono">runtime</span>
    </span>
  )
}

function UsageIndicator() {
  const usage = useQuery({
    queryKey: ['cursor', 'usage', 'topbar'],
    queryFn: cursorApi.usage,
    retry: 0,
    refetchInterval: 30_000,
  })
  if (!usage.data || !usage.data.usage.available) {
    return (
      <Link
        to="/billing"
        className="pill pill-muted hover:bg-surface-3"
        title="Cursor usage 未连接"
      >
        <Plug className="h-3 w-3" />
        cursor
      </Link>
    )
  }
  const auto = Math.min(100, Math.round(usage.data.usage.autoPercentUsed ?? 0))
  const api = Math.min(100, Math.round(usage.data.usage.apiPercentUsed ?? 0))
  const max = Math.max(auto, api)
  const tone = max >= 90 ? 'pill-bad' : max >= 70 ? 'pill-warn' : 'pill-ok'
  return (
    <Link
      to="/billing"
      className={cn('pill', tone, 'hover:opacity-90')}
      title={`Composer ${auto}% · API ${api}%`}
    >
      <span className="font-mono">composer {auto}%</span>
      <span className="opacity-50">·</span>
      <span className="font-mono">api {api}%</span>
    </Link>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof document === 'undefined') return 'dark'
    return document.documentElement.classList.contains('light') ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    try {
      localStorage.setItem('shujian.theme.v1', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  return (
    <button
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`${theme === 'dark' ? 'Light' : 'Dark'} theme`}
    >
      {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  )
}
