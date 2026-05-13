import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth-context'

/**
 * Login gate for `apps/future`. Renders a centered card matching the
 * 米纸朱红 paper aesthetic. Used to wrap <WarRoom /> so unauthenticated
 * users (or expired sessions) can recover without leaving the app.
 *
 * Auth flow lives in `lib/auth-context.tsx`; this component is purely UI.
 */
export function LoginGate() {
  const auth = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    idRef.current?.focus()
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await auth.login(identifier.trim(), password)
    } catch (err) {
      setError(humanize(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        padding: '48px 24px',
      }}
    >
      <form
        onSubmit={onSubmit}
        noValidate
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--leaf)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--paper-shadow)',
          padding: '40px 36px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="eyebrow">register · sign in</span>
          <h1
            className="serif"
            style={{
              margin: 0,
              fontSize: 28,
              lineHeight: '34px',
              letterSpacing: '-0.012em',
              color: 'var(--ink)',
            }}
          >
            书剑 Future · 学生卷宗
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            登录到你的工作区。还没有账号？联系工作区 owner 邀请你。
          </p>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="账号">
            <input
              ref={idRef}
              name="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              required
              aria-invalid={!!error}
              style={inputStyle}
            />
          </Field>
          <Field label="密码">
            <input
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              aria-invalid={!!error}
              style={inputStyle}
            />
          </Field>

          {error && (
            <div
              role="alert"
              style={{
                fontSize: 12,
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--vermilion-soft)',
                color: 'var(--vermilion-deep)',
                border: '1px solid var(--vermilion-soft)',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !identifier || !password}
            style={{
              height: 40,
              borderRadius: 'var(--radius)',
              background: 'var(--ink)',
              color: 'var(--paper)',
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.04em',
              opacity: submitting || !identifier || !password ? 0.55 : 1,
              transition: 'opacity 160ms var(--ease-out-quart)',
            }}
          >
            {submitting ? '正在登录…' : '登录到工作区'}
          </button>
        </div>

        <footer
          className="mono"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--faint)',
          }}
        >
          <span>opaque session · sha-256</span>
          <span>tls 1.3</span>
        </footer>
      </form>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  height: 38,
  width: '100%',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--hairline)',
  background: 'var(--paper)',
  padding: '0 12px',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
  transition: 'border-color 160ms var(--ease-out-quart)',
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function humanize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (
    lower.includes('invalid') ||
    lower.includes('credentials') ||
    lower.includes('unauthor')
  ) {
    return '账号或密码不对。'
  }
  if (
    lower.includes('502') ||
    lower.includes('reach') ||
    lower.includes('fetch')
  ) {
    return '后端无法连接，稍后再试或检查 VITE_BACKEND_URL。'
  }
  return msg
}
