import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth-context'
import { LoginGate } from './login-gate'

/**
 * Shared layout for every authenticated page: top bar with tenant +
 * logout, left sidebar with admin nav, and an `<Outlet />` for the
 * routed page content. Wraps `LoginGate` when the caller is anonymous.
 */
export function AdminShell() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return <BootScreen message="正在校验会话…" />
  }
  if (auth.status === 'anonymous') {
    return <LoginGate />
  }
  if (!auth.tenant) {
    return (
      <BootScreen message="还没有可用的工作区。让 owner 把你加入一个 tenant。" />
    )
  }

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        gridTemplateColumns: '220px 1fr',
        gridTemplateRows: '56px 1fr',
        background: 'var(--paper)',
      }}
    >
      <TopBar />
      <SideBar pathname={location.pathname} />
      <main
        style={{
          padding: '24px 32px 80px',
          minWidth: 0,
          overflowX: 'hidden',
        }}
      >
        <Outlet />
      </main>
    </div>
  )
}

function TopBar() {
  const auth = useAuth()
  const [busy, setBusy] = useState(false)

  return (
    <header
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        background: 'var(--leaf)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 16 }}
      >
        <span className="serif" style={{ fontSize: 18, color: 'var(--ink)' }}>
          书剑 Future
        </span>
        <span className="eyebrow" style={{ color: 'var(--faint)' }}>
          学生招募 CRM
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--ink-soft)',
            background: 'var(--inset)',
            border: '1px solid var(--hairline)',
            padding: '4px 10px',
            borderRadius: 999,
          }}
        >
          {auth.tenant?.display_name ?? auth.tenant?.name}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          {auth.user?.display_name ?? auth.user?.identifier}
        </span>
        <button
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              await auth.logout()
            } finally {
              setBusy(false)
            }
          }}
          disabled={busy}
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            padding: '4px 10px',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? '退出中…' : '退出'}
        </button>
      </div>
    </header>
  )
}

const NAV_ITEMS = [
  { to: '/students', label: '学生', desc: 'students' },
  { to: '/projects', label: '项目', desc: 'projects' },
  { to: '/share', label: '招募链接', desc: 'share-link' },
]

function SideBar({ pathname }: { pathname: string }) {
  return (
    <nav
      style={{
        background: 'var(--leaf-soft)',
        borderRight: '1px solid var(--hairline)',
        padding: '20px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(item.to)
        return (
          <NavLink
            key={item.to}
            to={item.to}
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              background: active ? 'var(--paper)' : 'transparent',
              border: active
                ? '1px solid var(--hairline)'
                : '1px solid transparent',
              boxShadow: active
                ? '0 1px 2px oklch(40% 0.04 70 / 0.04)'
                : 'none',
              textDecoration: 'none',
              transition: 'all 120ms var(--ease-out-quart)',
            }}
          >
            <span
              className="serif"
              style={{
                fontSize: 14,
                color: active ? 'var(--ink)' : 'var(--ink-soft)',
              }}
            >
              {item.label}
            </span>
            <span
              className="mono"
              style={{ fontSize: 10, color: 'var(--faint)' }}
            >
              {item.desc}
            </span>
          </NavLink>
        )
      })}
    </nav>
  )
}

function BootScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <p
        className="serif"
        style={{
          margin: 0,
          fontSize: 16,
          color: 'var(--muted)',
          letterSpacing: '0.04em',
        }}
      >
        {message}
      </p>
    </div>
  )
}
