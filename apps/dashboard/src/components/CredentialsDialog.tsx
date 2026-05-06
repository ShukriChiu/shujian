import { useEffect, useState } from 'react'
import { ExternalLink, Eye, EyeOff, KeyRound, Save, Trash2, X } from 'lucide-react'
import { clearCredentials, setCredentials } from '@/lib/credentials'
import { useCredentials } from '@/lib/useCredentials'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

export function CredentialsDialog({ open, onClose }: Props) {
  const stored = useCredentials()
  const [apiKey, setApiKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [showApi, setShowApi] = useState(false)
  const [showSession, setShowSession] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    if (open) {
      setApiKey(stored.apiKey)
      setSessionToken(stored.sessionToken)
      setShowApi(false)
      setShowSession(false)
    }
  }, [open, stored.apiKey, stored.sessionToken])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function save() {
    setCredentials({ apiKey: apiKey.trim(), sessionToken: sessionToken.trim() })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-ink-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-100 to-indigo-100 text-violet-700">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-ink-900">Cursor 凭证</div>
              <div className="text-[11px] text-ink-500">仅存浏览器本地 · 不发服务端 · 每次请求作 header 注入</div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-900">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* API key */}
          <Field
            label="CURSOR_API_KEY"
            hint={
              <>
                用于创建 agent / 列模型。在
                <a
                  href="https://cursor.com/dashboard/integrations"
                  target="_blank"
                  rel="noreferrer"
                  className="ml-0.5 inline-flex items-center gap-0.5 text-violet-700 underline decoration-violet-300 underline-offset-2 hover:decoration-violet-700"
                >
                  cursor.com/dashboard/integrations
                  <ExternalLink className="h-3 w-3" />
                </a>
                创建。
              </>
            }
          >
            <SecretInput
              placeholder="crsr_..."
              value={apiKey}
              onChange={setApiKey}
              show={showApi}
              setShow={setShowApi}
              prefixCheck={(v) => v.startsWith('crsr_')}
            />
          </Field>

          {/* Session token */}
          <Field
            label="WorkosCursorSessionToken"
            hint={
              <>
                用于读取个人计费用量。打开
                <a
                  href="https://cursor.com/dashboard"
                  target="_blank"
                  rel="noreferrer"
                  className="mx-0.5 inline-flex items-center gap-0.5 text-violet-700 underline decoration-violet-300 underline-offset-2 hover:decoration-violet-700"
                >
                  cursor.com/dashboard
                  <ExternalLink className="h-3 w-3" />
                </a>
                → DevTools → Application → Cookies → 复制 <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[10px]">WorkosCursorSessionToken</code> 的值。
              </>
            }
          >
            <SecretInput
              placeholder="user_xxx::eyJ..."
              value={sessionToken}
              onChange={setSessionToken}
              show={showSession}
              setShow={setShowSession}
              prefixCheck={(v) => /^user_[A-Z0-9]+%?3A%?3A/i.test(v) || v.includes('::')}
              monospace
            />
          </Field>

          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-[11px] text-amber-800">
            <strong className="font-semibold">注意</strong>：session token 60 天过期，过期后用量会显示 401，重新粘贴即可。
            API key 只要不在 Cursor dashboard 撤销就一直有效。
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ink-100 px-5 py-3">
          <button
            onClick={() => {
              clearCredentials()
              setApiKey('')
              setSessionToken('')
            }}
            className="btn btn-ghost h-8 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="h-3 w-3" />
            清除
          </button>
          <div className="flex items-center gap-2">
            <span className={cn('text-[11px] text-emerald-600 transition', savedFlash ? 'opacity-100' : 'opacity-0')}>
              已保存到本机
            </span>
            <button onClick={onClose} className="btn btn-ghost h-8 text-[11px]">
              取消
            </button>
            <button onClick={save} className="btn btn-primary h-8 text-[11px]">
              <Save className="h-3 w-3" />
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
        <span className="font-mono">{label}</span>
      </label>
      {children}
      {hint && <div className="mt-1 text-[11px] leading-snug text-ink-500">{hint}</div>}
    </div>
  )
}

function SecretInput({
  value,
  onChange,
  placeholder,
  show,
  setShow,
  prefixCheck,
  monospace,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  show: boolean
  setShow: (b: boolean) => void
  prefixCheck?: (v: string) => boolean
  monospace?: boolean
}) {
  const ok = !value || (prefixCheck ? prefixCheck(value) : true)
  return (
    <div className="flex items-center gap-1">
      <input
        type={show ? 'text' : 'password'}
        className={cn(
          'input flex-1',
          monospace && 'font-mono text-[12px]',
          !ok && 'border-amber-400 focus:border-amber-400 focus:ring-amber-200',
        )}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="btn btn-ghost h-9 px-2 shrink-0"
        title={show ? '隐藏' : '显示'}
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
