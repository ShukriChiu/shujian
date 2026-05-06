import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Check,
  Cloud,
  Eye,
  EyeOff,
  Globe2,
  Plug,
  Plus,
  Save,
  Server,
  Trash2,
  X,
} from 'lucide-react'
import {
  genId,
  LOCAL_ENDPOINT,
  removeBridge,
  setActiveBridge,
  upsertBridge,
  type Bridge,
} from '@/lib/bridges'
import { useActiveBridge, useBridges } from '@/lib/useBridges'
import { cursorApi, type CursorHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

export function BridgesDialog({ open, onClose }: Props) {
  const bridges = useBridges()
  const active = useActiveBridge()
  const qc = useQueryClient()

  const [editingId, setEditingId] = useState<string>(active.id)
  const editing = useMemo(
    () => bridges.find((b) => b.id === editingId) ?? bridges[0]!,
    [bridges, editingId],
  )

  useEffect(() => {
    if (open) setEditingId(active.id)
  }, [open, active.id])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function addNew() {
    const b: Bridge = {
      id: genId(),
      name: 'new-bridge',
      endpoint: 'https://',
      apiKey: '',
      sessionToken: '',
    }
    upsertBridge(b)
    setEditingId(b.id)
  }

  function activate(id: string) {
    setActiveBridge(id)
    qc.invalidateQueries({ queryKey: ['cursor'] })
  }

  function remove(id: string) {
    if (bridges.length <= 1) return
    removeBridge(id)
    if (editingId === id) {
      const fallback = bridges.find((b) => b.id !== id)
      if (fallback) setEditingId(fallback.id)
    }
    qc.invalidateQueries({ queryKey: ['cursor'] })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative grid w-full max-w-3xl grid-cols-[220px_1fr] overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xl">
        <aside className="border-r border-ink-100 bg-ink-50/40">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-700">
              <Server className="h-3 w-3" />
              Bridges
            </div>
            <button
              onClick={addNew}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-ink-600 hover:border-violet-300 hover:text-violet-700"
              title="新增 bridge"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          <ul className="max-h-[480px] overflow-auto p-1.5">
            {bridges.map((b) => {
              const selected = editingId === b.id
              const isActive = active.id === b.id
              return (
                <li key={b.id}>
                  <button
                    onClick={() => setEditingId(b.id)}
                    className={cn(
                      'group mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
                      selected ? 'bg-white shadow-sm ring-1 ring-violet-200' : 'hover:bg-white/70',
                    )}
                  >
                    {b.endpoint === LOCAL_ENDPOINT ? (
                      <Plug className="h-3 w-3 shrink-0 text-emerald-600" />
                    ) : (
                      <Globe2 className="h-3 w-3 shrink-0 text-violet-600" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-900">
                        <span className="truncate">{b.name}</span>
                        {isActive && (
                          <span className="rounded bg-emerald-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
                            active
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[10px] text-ink-500">{b.endpoint}</div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="border-t border-ink-100 p-2">
            <button onClick={onClose} className="btn btn-ghost h-7 w-full text-[11px]">
              关闭
            </button>
          </div>
        </aside>

        <main className="relative">
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-100 to-indigo-100 text-violet-700">
                <Cloud className="h-3.5 w-3.5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-ink-900">{editing.name}</div>
                <div className="font-mono text-[11px] text-ink-500">{editing.id}</div>
              </div>
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-900">
              <X className="h-4 w-4" />
            </button>
          </div>

          <BridgeEditor
            key={editing.id}
            bridge={editing}
            isActive={active.id === editing.id}
            onActivate={() => activate(editing.id)}
            onRemove={bridges.length > 1 ? () => remove(editing.id) : undefined}
            onAfterSave={() => qc.invalidateQueries({ queryKey: ['cursor'] })}
          />
        </main>
      </div>
    </div>
  )
}

function BridgeEditor({
  bridge,
  isActive,
  onActivate,
  onRemove,
  onAfterSave,
}: {
  bridge: Bridge
  isActive: boolean
  onActivate: () => void
  onRemove?: () => void
  onAfterSave: () => void
}) {
  const [name, setName] = useState(bridge.name)
  const [endpoint, setEndpoint] = useState(bridge.endpoint)
  const [apiKey, setApiKey] = useState(bridge.apiKey)
  const [sessionToken, setSessionToken] = useState(bridge.sessionToken)
  const [showApi, setShowApi] = useState(false)
  const [showSession, setShowSession] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<CursorHealth | null>(null)
  const [probeErr, setProbeErr] = useState<string | null>(null)

  function save() {
    upsertBridge({
      ...bridge,
      name: name.trim() || bridge.id,
      endpoint: endpoint.trim() || LOCAL_ENDPOINT,
      apiKey: apiKey.trim(),
      sessionToken: sessionToken.trim(),
    })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
    onAfterSave()
  }

  async function probeNow() {
    setProbing(true)
    setProbeErr(null)
    setProbe(null)
    try {
      const headers: Record<string, string> = {}
      if (apiKey.trim()) headers['X-Cursor-Api-Key'] = apiKey.trim()
      if (sessionToken.trim()) headers['X-Cursor-Session-Token'] = sessionToken.trim()
      const h = await cursorApi.probeAt(endpoint.trim() || LOCAL_ENDPOINT, headers)
      setProbe(h)
    } catch (e) {
      setProbeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="macmini-studio"
          />
        </Field>
        <Field label="Endpoint" hint="本地用 /cursor（走 Vite 代理），远端用完整 https://...">
          <input
            className="input font-mono text-[12px]"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://mac-studio.tunnel.example.com"
          />
        </Field>
      </div>

      <Field label="CURSOR_API_KEY" hint="这台 bridge 专属的 Cursor 账号 key（crsr_...）">
        <SecretInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="crsr_..."
          show={showApi}
          setShow={setShowApi}
          prefixCheck={(v) => v.startsWith('crsr_')}
        />
      </Field>

      <Field
        label="WorkosCursorSessionToken (可选)"
        hint="只用于显示个人计费。如果这台 bridge 是别人的 Mac mini，留空。"
      >
        <SecretInput
          value={sessionToken}
          onChange={setSessionToken}
          placeholder="user_xxx::eyJ..."
          show={showSession}
          setShow={setShowSession}
          monospace
        />
      </Field>

      <div className="rounded-lg border border-ink-200 bg-ink-50/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-700">
            <Activity className="h-3 w-3" />
            Health probe
          </div>
          <button onClick={probeNow} disabled={probing} className="btn btn-ghost h-7 text-[11px]">
            {probing ? '探测中…' : '现在探测'}
          </button>
        </div>
        {probe && probe.ok ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-ink-700">
            <Stat k="name" v={probe.name ?? '—'} />
            <Stat k="version" v={probe.version ?? '—'} />
            <Stat k="uptime" v={probe.uptime != null ? `${probe.uptime}s` : '—'} />
            <Stat k="agents · runs" v={`${probe.activeAgents ?? 0} · ${probe.activeRuns ?? 0}`} />
          </div>
        ) : probeErr ? (
          <div className="text-[11px] text-red-600">{probeErr}</div>
        ) : probe && !probe.ok ? (
          <div className="text-[11px] text-amber-700">Bridge 不健康（HTTP 非 200）</div>
        ) : (
          <div className="text-[11px] text-ink-500">点「现在探测」检查这台 bridge 是否在线。</div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
        {onRemove ? (
          <button
            onClick={onRemove}
            className="btn btn-ghost h-8 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="h-3 w-3" />
            删除
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {!isActive && (
            <button onClick={onActivate} className="btn btn-ghost h-8 text-[11px] text-violet-700">
              <Check className="h-3 w-3" />
              设为当前
            </button>
          )}
          <span className={cn('text-[11px] text-emerald-600 transition', savedFlash ? 'opacity-100' : 'opacity-0')}>
            已保存
          </span>
          <button onClick={save} className="btn btn-primary h-8 text-[11px]">
            <Save className="h-3 w-3" />
            保存
          </button>
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

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-ink-100 py-0.5 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">{k}</span>
      <span className="font-mono text-[11px] text-ink-900">{v}</span>
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
