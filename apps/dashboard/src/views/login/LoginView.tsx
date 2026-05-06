import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, Loader2 } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { Logomark, Wordmark } from '@/components/Logomark'
import { SystemPulse } from './SystemPulse'

export function LoginView() {
  const auth = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/agents'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    idRef.current?.focus()
  }, [])

  if (auth.status === 'authenticated') {
    return <Navigate to={next} replace />
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await auth.login(identifier.trim(), password)
      nav(next, { replace: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(humanizeError(msg))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid h-full min-h-[640px] grid-cols-1 bg-bg lg:grid-cols-[3fr_2fr]">
      {/* Left — system pulse */}
      <div className="relative hidden overflow-hidden border-r border-line bg-surface lg:block">
        <SystemPulse />
        {/* corner mark */}
        <div className="pointer-events-none absolute right-10 top-10">
          <Logomark size={28} />
        </div>
      </div>

      {/* Right — auth */}
      <div className="relative flex items-center justify-center px-6 py-12 sm:px-12">
        <div className="absolute left-6 top-6 lg:hidden">
          <Wordmark />
        </div>
        <form
          onSubmit={onSubmit}
          className="w-full max-w-[420px] space-y-7 animate-fade-up"
          noValidate
        >
          <div className="space-y-2">
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-ink-dim">
              register · sign in
            </div>
            <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.022em] text-ink">
              欢迎回来
            </h1>
            <p className="text-sm text-ink-muted">
              使用工作账号登录到你的工作区。还没有账号？
              {' '}
              <span className="text-ink-dim">联系工作区 owner 邀请你。</span>
            </p>
          </div>

          <div className="space-y-4">
            <Field label="账号">
              <input
                ref={idRef}
                name="identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                required
                className="input"
                aria-invalid={!!error}
              />
            </Field>
            <Field
              label="密码"
              hint={
                <Link to="#" className="text-ink-dim hover:text-ink">
                  忘记密码？
                </Link>
              }
            >
              <input
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                className="input"
                aria-invalid={!!error}
              />
            </Field>

            {error && (
              <div
                role="alert"
                className="rounded-md border px-3 py-2 text-xs"
                style={{
                  borderColor: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h) / 0.42)',
                  background: 'var(--bad-tint)',
                  color: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h))',
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !identifier || !password}
              className="btn btn-primary h-10 w-full text-sm"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在登录
                </>
              ) : (
                <>
                  登录到 Register
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-ink-dim">
            <span className="font-mono">opaque session · sha-256</span>
            <span className="font-mono">tls 1.3</span>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-ink-muted">{label}</span>
        {hint && <span className="text-[11px]">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

function humanizeError(msg: string): string {
  const lower = msg.toLowerCase()
  if (lower.includes('invalid') || lower.includes('credentials') || lower.includes('unauthor')) {
    return '账号或密码不对。'
  }
  if (lower.includes('502') || lower.includes('reach') || lower.includes('fetch')) {
    return '后端无法连接，稍后再试或检查 VITE_BACKEND_URL。'
  }
  return msg
}
