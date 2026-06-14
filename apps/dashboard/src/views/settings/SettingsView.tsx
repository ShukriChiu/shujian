import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, Cpu, KeyRound, Plug, Plus, Trash2, User as UserIcon } from 'lucide-react'
import { agentApi, cursorApi } from '@/lib/api'
import {
  genId,
  getActiveBridgeId,
  listBridges,
  onBridgesChange,
  removeBridge,
  setActiveBridge,
  upsertBridge,
  type Bridge,
} from '@/lib/bridges'
import { useAuth } from '@/lib/auth-context'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'

type Section = 'account' | 'bridges' | 'preferences' | 'system'

const SECTIONS: Array<{ id: Section; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'account', label: '账户', icon: UserIcon },
  { id: 'bridges', label: 'Bridges', icon: Plug },
  { id: 'preferences', label: '偏好', icon: Activity },
  { id: 'system', label: '系统', icon: Cpu },
]

export function SettingsView() {
  const { section } = useParams<{ section?: string }>()
  const active = (SECTIONS.find((s) => s.id === section)?.id ?? 'account') as Section

  return (
    <div className="flex flex-col">
      <PageHeader title="Settings" description="账户、桥、偏好、系统状态。修改即时生效。" />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="border-y border-line bg-bg lg:border-r lg:border-y-0 lg:bg-transparent">
          <ul className="flex flex-row gap-1 overflow-x-auto p-3 lg:flex-col">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/settings/${s.id}`}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-md px-2.5 text-sm transition-colors',
                    active === s.id ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                  )}
                  data-active={active === s.id}
                >
                  <s.icon className={cn('h-3.5 w-3.5', active === s.id ? 'text-accent' : 'text-ink-dim')} />
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="mx-auto w-full max-w-[720px] px-6 py-8">
          {active === 'account' && <AccountSection />}
          {active === 'bridges' && <BridgesSection />}
          {active === 'preferences' && <PreferencesSection />}
          {active === 'system' && <SystemSection />}
        </section>
      </div>
    </div>
  )
}

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6 border-b border-line pb-5">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
    </header>
  )
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-line py-5 last:border-b-0 md:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-dim">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// — sections —

function AccountSection() {
  const auth = useAuth()
  if (!auth.user) return null
  return (
    <>
      <SectionHeading title="账户" description="登录身份与多工作区成员关系。" />
      <FormRow label="账号" hint="登录用，不可改">
        <div className="font-mono text-sm text-ink">{auth.user.identifier}</div>
      </FormRow>
      <FormRow label="昵称">
        <input className="input" defaultValue={auth.user.display_name ?? ''} placeholder="留空则用账号" disabled />
        <div className="mt-1 text-[11px] text-ink-dim">编辑接口待 backend /v1/users/me 上线</div>
      </FormRow>
      <FormRow label="工作区">
        <ul className="space-y-1.5">
          {auth.tenants.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold uppercase text-ink-inv"
                  style={{ background: 'oklch(var(--accent-l) var(--accent-c) var(--accent-h))' }}
                >
                  {t.slug.slice(0, 1)}
                </span>
                <span className="font-mono text-sm">{t.slug}</span>
                <span className="text-xs text-ink-dim">{t.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {t.role && <span className="pill pill-muted">{t.role}</span>}
                {auth.tenant?.id === t.id && <span className="pill pill-accent">current</span>}
              </div>
            </li>
          ))}
        </ul>
      </FormRow>
      <FormRow label="退出登录" hint="清除本地 session token 并跳转回 /login">
        <button onClick={() => auth.logout()} className="btn">
          Sign out
        </button>
      </FormRow>
    </>
  )
}

function PreferencesSection() {
  const [theme, setTheme] = useState<'system' | 'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'system'
    const stored = localStorage.getItem('shujian.theme.v1')
    return stored === 'dark' || stored === 'light' ? stored : 'system'
  })

  useEffect(() => {
    if (theme === 'system') {
      localStorage.removeItem('shujian.theme.v1')
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
      document.documentElement.classList.toggle('light', prefersLight)
    } else {
      localStorage.setItem('shujian.theme.v1', theme)
      document.documentElement.classList.toggle('light', theme === 'light')
    }
  }, [theme])

  return (
    <>
      <SectionHeading title="偏好" description="不存到服务端，按浏览器记。" />
      <FormRow label="主题" hint="default 跟随系统色">
        <div className="inline-flex rounded-md border border-line bg-surface-2 p-1">
          {(['system', 'dark', 'light'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={cn(
                'h-7 rounded px-3 text-xs transition-colors',
                theme === t ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </FormRow>
      <FormRow label="键盘快捷键" hint="只读">
        <ul className="space-y-1.5 font-mono text-xs">
          <li className="flex items-center gap-3">
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
            <span className="text-ink-muted">打开 Jump-to / Command 面板</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="kbd">esc</span>
            <span className="text-ink-muted">关闭面板 / 取消 / 收起 detail rail</span>
          </li>
        </ul>
      </FormRow>
    </>
  )
}

function SystemSection() {
  const health = useQuery({ queryKey: ['agent', 'health'], queryFn: agentApi.health, retry: 0 })
  const me = useQuery({ queryKey: ['cursor', 'me'], queryFn: cursorApi.me, retry: 0 })
  const meta = useQuery({ queryKey: ['cursor', 'meta'], queryFn: cursorApi.meta, retry: 0 })

  return (
    <>
      <SectionHeading title="系统" description="本地 runtime 与桥的健康状态。" />
      <FormRow label="shujian-agent (Rust)" hint="本地 daemon · 端口 8002">
        {health.error ? (
          <p className="text-sm text-bad">offline · 用 just dev-agent 起一下</p>
        ) : health.data ? (
          <dl className="space-y-1 font-mono text-xs">
            <Row k="status" v={health.data.status} />
            <Row k="version" v={`v${health.data.version}`} />
            <Row k="agents" v={`${health.data.agents.length}: ${health.data.agents.join(', ')}`} />
            <Row k="proxy" v="/api → :8002 (vite)" />
          </dl>
        ) : (
          <p className="text-sm text-ink-dim">加载中</p>
        )}
      </FormRow>
      <FormRow label="cursor-bridge (Node)" hint="@cursor/sdk 边车">
        {me.error ? (
          <p className="text-sm text-bad">offline · cd shujian-agent/cursor-bridge && bun run dev</p>
        ) : (
          <dl className="space-y-1 font-mono text-xs">
            <Row k="proxy" v="/cursor → bridge (vite, see BRIDGE_DEV_TARGET)" />
            {meta.data && <Row k="active agents" v={String(meta.data.activeAgents)} />}
            {meta.data && <Row k="active runs" v={String(meta.data.activeRuns)} />}
            {me.data && <Row k="api key" v={me.data.apiKeyName} />}
          </dl>
        )}
      </FormRow>
      <FormRow label="shujian-backend (Rust)" hint="租户 / 鉴权 / 审计 · Railway">
        <dl className="space-y-1 font-mono text-xs">
          <Row k="proxy" v="/backend → :8080 (vite, dev only)" />
          <Row k="prod" v="VITE_BACKEND_URL = https://… (build env)" />
        </dl>
      </FormRow>
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
      <dt className="text-ink-dim">{k}</dt>
      <dd className="break-all text-ink">{v}</dd>
    </div>
  )
}

// — bridges section —

function BridgesSection() {
  const [, force] = useState({})
  useEffect(() => onBridgesChange(() => force({})), [])
  const bridges = listBridges()
  const activeId = getActiveBridgeId()
  const [editId, setEditId] = useState<string | null>(null)
  const editing = bridges.find((b) => b.id === editId) ?? null

  return (
    <>
      <SectionHeading
        title="Bridges"
        description="一个 bridge = 一个 cursor-bridge 实例 + 它绑定的 Cursor 凭证。Active 那个会接收所有 cloud agent 调度。"
      />
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div className="text-xs text-ink-dim">
          {bridges.length} bridges · active: <span className="font-mono text-ink-muted">{activeId}</span>
        </div>
        <button
          onClick={() => setEditId('__new__')}
          className="btn btn-primary whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" /> 新增 bridge
        </button>
      </div>
      <ul className="divide-y divide-line">
        {bridges.map((b) => (
          <li
            key={b.id}
            className="flex items-center gap-3 py-3 text-sm"
          >
            <span className={cn('dot shrink-0', b.id === activeId ? 'dot-running' : 'dot-idle')} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-ink">{b.name}</span>
              <span className="truncate font-mono text-[11px] text-ink-dim">{b.endpoint}</span>
            </span>
            <span className="hidden shrink-0 font-mono text-xs text-ink-muted md:block">
              {b.apiKey ? `key …${b.apiKey.slice(-4)}` : <span className="text-warn">no key</span>}
              {b.sessionToken ? ' · session' : ''}
            </span>
            {b.id !== activeId && (
              <button
                onClick={() => setActiveBridge(b.id)}
                className="btn h-7 shrink-0 whitespace-nowrap px-2 text-xs"
              >
                Activate
              </button>
            )}
            <button
              onClick={() => setEditId(b.id)}
              className="btn btn-ghost h-7 shrink-0 px-2 text-xs"
            >
              <KeyRound className="h-3 w-3" /> 编辑
            </button>
            {b.id !== 'local' && b.id !== 'cloud' && (
              <button
                onClick={() => {
                  if (confirm(`删除 bridge "${b.name}"?`)) removeBridge(b.id)
                }}
                className="btn btn-ghost h-7 w-7 shrink-0 px-0 hover:text-bad"
                aria-label="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing !== null || editId === '__new__' ? (
        <BridgeEditor
          bridge={editing}
          onClose={() => setEditId(null)}
        />
      ) : null}
    </>
  )
}

function BridgeEditor({ bridge, onClose }: { bridge: Bridge | null; onClose: () => void }) {
  const isNew = bridge === null
  const [name, setName] = useState(bridge?.name ?? '')
  const [endpoint, setEndpoint] = useState(bridge?.endpoint ?? 'https://')
  const [apiKey, setApiKey] = useState(bridge?.apiKey ?? '')
  const [sessionToken, setSessionToken] = useState(bridge?.sessionToken ?? '')

  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  function save() {
    upsertBridge({
      id: bridge?.id ?? genId(),
      name: name.trim() || 'unnamed',
      endpoint: endpoint.trim() || '/cursor',
      apiKey: apiKey.trim(),
      sessionToken: sessionToken.trim(),
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 px-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-[520px] origin-center animate-fade-up rounded-xl border border-line-strong bg-surface-2 p-6"
      >
        <h3 className="text-lg font-semibold text-ink">{isNew ? '新增 bridge' : '编辑 bridge'}</h3>
        <p className="mt-1 text-xs text-ink-dim">
          local 桥固定为 /cursor (vite 代理 :8003)。远端桥用完整 https URL。
        </p>
        <div className="mt-5 space-y-4">
          <Field label="名称">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="cloud" autoFocus />
          </Field>
          <Field label="Endpoint" hint="本地填 /cursor; 远端填完整 origin">
            <input className="input font-mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          </Field>
          <Field label="Cursor API Key" hint="key_xxx (必填)">
            <input
              type="password"
              className="input font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="key_…"
            />
          </Field>
          <Field label="Session Token" hint="WorkosCursorSessionToken cookie (可选, 用于 /usage)">
            <input
              type="password"
              className="input font-mono"
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value)}
              placeholder="(optional)"
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn">
            取消
          </button>
          <button onClick={save} className="btn btn-primary">
            保存
          </button>
        </div>
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
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          {label}
        </span>
        {hint && <span className="text-[10px] text-ink-dim">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
