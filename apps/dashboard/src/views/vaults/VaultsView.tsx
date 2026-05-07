import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  genVaultId,
  looksLikeSecretKey,
  maskValue,
  removeVault,
  upsertVault,
  type Vault,
} from '@/lib/vaults'
import { useVaults } from '@/lib/useVaults'
import {
  SECRET_KINDS,
  looksLikeSecretName,
  serverVaults,
  type KekStatus,
  type SecretKind,
  type ServerSecretMetadata,
} from '@/lib/serverVaults'
import { BackendError } from '@/lib/backend'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

type Tab = 'server' | 'local'

export function VaultsView() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'local' ? 'local' : 'server'

  function setTab(next: Tab) {
    const p = new URLSearchParams(params)
    if (next === 'local') p.set('tab', 'local')
    else p.delete('tab')
    p.delete('id')
    p.delete('new')
    p.delete('name')
    setParams(p, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end justify-between gap-4 px-6 pt-6">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.012em] text-ink">Vaults</h1>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">
            租户级凭证。服务端 Vaults 用 AES-256-GCM 加密落库，KEK 在 backend 进程外
            （Railway env，未来可换 KMS）；启动 persona 时按 scope 解密成短时 envVars 注入。本地草稿仍是 PoC，仅本浏览器可见。
          </p>
        </div>
      </div>

      <nav className="mt-3 border-b border-line px-6">
        <div className="flex gap-1 text-xs font-medium">
          <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
            服务端 Vaults
          </TabButton>
          <TabButton active={tab === 'local'} onClick={() => setTab('local')}>
            本地草稿（legacy）
          </TabButton>
        </div>
      </nav>

      <div className="min-h-0 flex-1">
        {tab === 'server' ? <ServerVaultsTab /> : <LocalVaultsTab />}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative -mb-px border-b-2 px-3 py-2.5 transition-colors',
        active
          ? 'border-accent text-ink'
          : 'border-transparent text-ink-dim hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Server tab
// ─────────────────────────────────────────────────────────────────────────────

function ServerVaultsTab() {
  const [params, setParams] = useSearchParams()
  const selectedName = params.get('name')
  const newOpen = params.get('new') === '1'

  const [secrets, setSecrets] = useState<ServerSecretMetadata[] | null>(null)
  const [kek, setKek] = useState<KekStatus | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setLoadErr(null)
    try {
      const [list, k] = await Promise.all([
        serverVaults.listSecrets(),
        serverVaults.kekStatus(),
      ])
      setSecrets(list)
      setKek(k)
    } catch (e) {
      const msg = e instanceof BackendError ? e.message : String(e)
      setLoadErr(msg)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selected = secrets?.find((s) => s.name === selectedName) ?? null

  function selectSecret(name: string | null) {
    const next = new URLSearchParams(params)
    if (name) next.set('name', name)
    else next.delete('name')
    next.delete('new')
    setParams(next, { replace: true })
  }
  function openNew() {
    const next = new URLSearchParams(params)
    next.delete('name')
    next.set('new', '1')
    setParams(next, { replace: true })
  }
  function closeRail() {
    const next = new URLSearchParams(params)
    next.delete('name')
    next.delete('new')
    setParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title=""
        meta={
          <KekBadge status={kek} />
        }
        actions={
          <>
            <button
              onClick={refresh}
              disabled={busy}
              className="btn btn-ghost h-8 px-2 text-xs"
              title="重新加载"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
              刷新
            </button>
            <button
              onClick={openNew}
              disabled={!kek?.configured}
              className="btn btn-primary"
              title={!kek?.configured ? 'KEK 未配置，无法加密写入' : ''}
            >
              <Plus className="h-4 w-4" /> 新建 Secret
            </button>
          </>
        }
      />

      {loadErr && (
        <div className="mx-6 mb-3 flex items-start gap-2 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">服务端 Vault 不可用</div>
            <div className="mt-0.5 font-mono text-[11px]">{loadErr}</div>
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="overflow-y-auto scroll-thin">
          {secrets === null && !loadErr ? (
            <div className="px-6 py-10 text-center text-xs text-ink-dim">加载中…</div>
          ) : secrets && secrets.length === 0 ? (
            <div className="px-6 py-10">
              <EmptyState
                glyph={<KeyRound className="h-5 w-5" />}
                title="还没有服务端 secret"
                hint={
                  <>
                    每个 secret = 一个加密落库的键值（如 onion.database_url）。
                    <br />
                    建议先把 onion-agent .env 里的 DATABASE_URL 和 R2 七件套灌进来，
                    <br />
                    再通过 scope + persona 注入给 AI。
                  </>
                }
                action={
                  <button
                    onClick={openNew}
                    disabled={!kek?.configured}
                    className="btn btn-primary"
                  >
                    <Plus className="h-4 w-4" /> 创建第一个 secret
                  </button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {(secrets ?? []).map((s) => (
                <SecretRow
                  key={s.id}
                  s={s}
                  active={s.name === selectedName}
                  onSelect={() => selectSecret(s.name)}
                />
              ))}
            </ul>
          )}
        </div>

        {(selected || newOpen) && (
          <aside className="hidden border-l border-line bg-surface xl:flex xl:flex-col">
            {newOpen ? (
              <ServerSecretEditor
                key="new"
                kekConfigured={!!kek?.configured}
                onClose={closeRail}
                onSaved={async (name) => {
                  await refresh()
                  selectSecret(name)
                }}
              />
            ) : selected ? (
              <ServerSecretEditor
                key={selected.name}
                secret={selected}
                kekConfigured={!!kek?.configured}
                onClose={closeRail}
                onSaved={async (name) => {
                  await refresh()
                  selectSecret(name)
                }}
                onDeleted={async () => {
                  await refresh()
                  closeRail()
                }}
              />
            ) : null}
          </aside>
        )}
      </div>
    </div>
  )
}

function KekBadge({ status }: { status: KekStatus | null }) {
  if (!status) return null
  if (!status.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-bad/30 bg-bad/5 px-2 py-0.5 font-mono text-[11px] text-bad">
        <ShieldAlert className="h-3 w-3" />
        KEK 未配置
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-good/30 bg-good/5 px-2 py-0.5 font-mono text-[11px] text-good">
      <ShieldCheck className="h-3 w-3" />
      KEK v{status.active_version}
      <span className="text-ink-dim">·</span>
      <span className="text-ink-dim">{status.source}</span>
      {status.fingerprint && (
        <>
          <span className="text-ink-dim">·</span>
          <span className="text-ink-dim">{status.fingerprint.slice(0, 8)}</span>
        </>
      )}
    </span>
  )
}

function SecretRow({
  s,
  active,
  onSelect,
}: {
  s: ServerSecretMetadata
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        onClick={onSelect}
        className={cn(
          'grid w-full grid-cols-[14px_minmax(0,1.6fr)_minmax(0,1fr)_80px_120px] items-center gap-3 px-6 py-3 text-left transition-colors',
          active ? 'bg-[var(--accent-tint)]' : 'hover:bg-surface-2',
        )}
      >
        <KeyRound
          className={cn(
            'h-3.5 w-3.5',
            looksLikeSecretName(s.name) ? 'text-accent' : 'text-ink-dim',
          )}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs text-ink">{s.name}</span>
          {s.description && (
            <span className="truncate text-[11px] text-ink-dim">{s.description}</span>
          )}
        </span>
        <span className="font-mono text-[11px] text-ink-muted">{s.kind}</span>
        <span className="font-mono text-[11px] text-ink-dim">v{s.kek_version}</span>
        <span className="text-right font-mono text-[11px] text-ink-dim">
          {new Date(s.rotated_at ?? s.created_at).toLocaleDateString('zh-CN')}
        </span>
      </button>
    </li>
  )
}

function ServerSecretEditor({
  secret,
  kekConfigured,
  onClose,
  onSaved,
  onDeleted,
}: {
  secret?: ServerSecretMetadata
  kekConfigured: boolean
  onClose: () => void
  onSaved: (name: string) => Promise<void> | void
  onDeleted?: () => Promise<void> | void
}) {
  const isEdit = !!secret
  const [name, setName] = useState(secret?.name ?? '')
  const [kind, setKind] = useState<SecretKind>((secret?.kind as SecretKind) ?? 'env')
  const [description, setDescription] = useState(secret?.description ?? '')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setErr(null)
    const cleanName = name.trim().toLowerCase()
    if (!cleanName) {
      setErr('name required')
      return
    }
    if (!value) {
      setErr(
        isEdit
          ? '修改 secret 等价于覆盖；请粘贴新值（不能与历史值留空）'
          : 'value 不能为空',
      )
      return
    }
    setBusy(true)
    try {
      await serverVaults.upsertSecret({
        name: cleanName,
        value,
        kind,
        description: description.trim() || null,
      })
      await onSaved(cleanName)
    } catch (e) {
      setErr(e instanceof BackendError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    if (!secret || !onDeleted) return
    if (!confirm(`确认删除 secret "${secret.name}"? 任何 scope 的 passthrough 引用都会失效。`))
      return
    setBusy(true)
    try {
      await serverVaults.deleteSecret(secret.name)
      await onDeleted()
    } catch (e) {
      setErr(e instanceof BackendError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <span className="text-sm font-medium text-ink">
          {isEdit ? '编辑 Secret' : '新建 Secret'}
        </span>
        <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 scroll-thin">
        {!kekConfigured && (
          <div className="flex items-start gap-2 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              KEK 未配置，无法加密写入。在 backend 设 SHUJIAN_VAULT_KEK_B64
              （Railway env，prod），或 SHUJIAN_VAULT_DEV_KEK_B64（本地 dev）。
              生成：<code className="font-mono">openssl rand -base64 32</code>。
            </div>
          </div>
        )}

        <Field
          label="名称"
          required
          hint={isEdit ? '不可改名（改名 = 新建）' : 'lowercase + 点分（如 onion.database_url）'}
        >
          <input
            className="input font-mono"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="onion.database_url"
            autoFocus
            disabled={isEdit}
          />
        </Field>

        <Field label="kind">
          <select
            className="input font-mono"
            value={kind}
            onChange={(e) => setKind(e.target.value as SecretKind)}
          >
            {SECRET_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label} — {k.hint}
              </option>
            ))}
          </select>
        </Field>

        <Field label="描述（可选）">
          <input
            className="input"
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="趣学洋葱主库 DSN（Railway PG）"
          />
        </Field>

        <Field
          label={isEdit ? '新值（覆盖）' : 'value'}
          required
          hint={isEdit ? '保存即视为轮换；旧密文会被替换并刷新 rotated_at' : ''}
        >
          <div className="flex items-stretch gap-2">
            <input
              className="input flex-1 font-mono"
              type={reveal ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isEdit ? '粘贴新值' : 'postgresql://…'}
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="btn btn-ghost w-9 px-0"
              aria-label={reveal ? 'Hide' : 'Reveal'}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </Field>

        {isEdit && secret && (
          <div className="space-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-dim">
            <div>id: {secret.id}</div>
            <div>kek_version: v{secret.kek_version}</div>
            <div>created: {new Date(secret.created_at).toLocaleString('zh-CN')}</div>
            {secret.rotated_at && (
              <div>rotated: {new Date(secret.rotated_at).toLocaleString('zh-CN')}</div>
            )}
            {secret.last_used_at && (
              <div>last used: {new Date(secret.last_used_at).toLocaleString('zh-CN')}</div>
            )}
          </div>
        )}

        {err && (
          <div className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
            {err}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3">
        {isEdit && onDeleted ? (
          <button
            onClick={destroy}
            disabled={busy}
            className="btn btn-ghost text-xs hover:text-bad"
          >
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button onClick={onClose} disabled={busy} className="btn">
            取消
          </button>
          <button
            onClick={save}
            disabled={busy || !kekConfigured}
            className="btn btn-primary"
          >
            {busy ? '加密落库…' : isEdit ? '覆盖保存' : '加密保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Local tab (legacy)
// ─────────────────────────────────────────────────────────────────────────────

function LocalVaultsTab() {
  const vaults = useVaults()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('id')
  const newOpen = params.get('new') === '1'
  const selected = vaults.find((v) => v.id === selectedId) ?? null

  function selectVault(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    next.delete('new')
    setParams(next, { replace: true })
  }
  function openNew() {
    const next = new URLSearchParams(params)
    next.delete('id')
    next.set('new', '1')
    setParams(next, { replace: true })
  }
  function closeRail() {
    const next = new URLSearchParams(params)
    next.delete('id')
    next.delete('new')
    setParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title=""
        meta={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-dim">
            <ShieldAlert className="h-3 w-3" />
            仅本浏览器 · 不加密
          </span>
        }
        actions={
          <button onClick={openNew} className="btn btn-primary">
            <Plus className="h-4 w-4" /> 新建本地草稿
          </button>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-y-auto scroll-thin">
          {vaults.length === 0 ? (
            <div className="px-6 py-10">
              <EmptyState
                glyph={<KeyRound className="h-5 w-5" />}
                title="本地草稿区为空"
                hint={
                  <>
                    本地草稿仅留作 PoC，凭证在你的浏览器 localStorage 里。
                    <br />
                    生产环境用上面的"服务端 Vaults"。
                  </>
                }
                action={
                  <button onClick={openNew} className="btn">
                    <Plus className="h-4 w-4" /> 新建草稿
                  </button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {vaults.map((v) => (
                <LocalVaultRow
                  key={v.id}
                  v={v}
                  active={v.id === selectedId}
                  onSelect={() => selectVault(v.id)}
                />
              ))}
            </ul>
          )}
        </div>
        {(selected || newOpen) && (
          <aside className="hidden border-l border-line bg-surface xl:flex xl:flex-col">
            {newOpen ? (
              <LocalVaultEditor key="new" onClose={closeRail} onSaved={(id) => selectVault(id)} />
            ) : selected ? (
              <LocalVaultEditor
                key={selected.id}
                vault={selected}
                onClose={closeRail}
                onSaved={(id) => selectVault(id)}
                onDeleted={() => closeRail()}
              />
            ) : null}
          </aside>
        )}
      </div>
    </div>
  )
}

function LocalVaultRow({
  v,
  active,
  onSelect,
}: {
  v: Vault
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        onClick={onSelect}
        className={cn(
          'grid w-full grid-cols-[14px_minmax(0,1.4fr)_minmax(0,1fr)_120px_120px] items-center gap-3 px-6 py-3 text-left transition-colors',
          active ? 'bg-[var(--accent-tint)]' : 'hover:bg-surface-2',
        )}
      >
        <KeyRound className="h-3.5 w-3.5 text-accent" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink">{v.name}</span>
          {v.description && (
            <span className="truncate text-xs text-ink-dim">{v.description}</span>
          )}
        </span>
        <span className="font-mono text-xs text-ink-muted">
          {Object.keys(v.envs).length} keys
        </span>
        <span className="font-mono text-xs text-ink-dim">
          {v.tags && v.tags.length > 0 ? v.tags.join(', ') : '—'}
        </span>
        <span className="text-right font-mono text-xs text-ink-dim">
          {new Date(v.updatedAt).toLocaleDateString('zh-CN')}
        </span>
      </button>
    </li>
  )
}

function LocalVaultEditor({
  vault,
  onClose,
  onSaved,
  onDeleted,
}: {
  vault?: Vault
  onClose: () => void
  onSaved: (id: string) => void
  onDeleted?: () => void
}) {
  const isEdit = !!vault
  const [name, setName] = useState(vault?.name ?? '')
  const [description, setDescription] = useState(vault?.description ?? '')
  const [tags, setTags] = useState((vault?.tags ?? []).join(', '))
  const [pairs, setPairs] = useState<Array<{ k: string; v: string; reveal: boolean }>>(() =>
    vault
      ? Object.entries(vault.envs).map(([k, v]) => ({ k, v, reveal: false }))
      : [{ k: '', v: '', reveal: true }],
  )

  function setPair(i: number, patch: Partial<{ k: string; v: string; reveal: boolean }>) {
    setPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  }
  function addPair() {
    setPairs((prev) => [...prev, { k: '', v: '', reveal: true }])
  }
  function removePair(i: number) {
    setPairs((prev) => prev.filter((_, idx) => idx !== i))
  }
  function pasteFromEnv(text: string) {
    const lines = text.split('\n')
    const newPairs: Array<{ k: string; v: string; reveal: boolean }> = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (k) newPairs.push({ k, v, reveal: false })
    }
    if (newPairs.length === 0) return
    setPairs((prev) => [...prev.filter((p) => p.k || p.v), ...newPairs])
  }

  function save() {
    const envs: Record<string, string> = {}
    for (const p of pairs) {
      const key = p.k.trim()
      if (!key) continue
      envs[key] = p.v
    }
    const id = vault?.id ?? genVaultId()
    const tagsArr = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    upsertVault({
      id,
      name: name.trim() || (vault ? vault.name : 'untitled'),
      description: description.trim(),
      tags: tagsArr,
      envs,
      createdAt: vault?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    onSaved(id)
  }

  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <span className="text-sm font-medium text-ink">
          {isEdit ? '编辑草稿' : '新建草稿'}
        </span>
        <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 scroll-thin">
        <Field label="名称" required>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="stripe-prod"
            autoFocus
          />
        </Field>
        <Field label="描述（可选）">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="主站 stripe 凭证"
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="prod, billing"
          />
        </Field>

        <div className="pt-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">
              环境变量 ({pairs.filter((p) => p.k).length})
            </span>
            <button
              onClick={() => {
                navigator.clipboard.readText().then(pasteFromEnv).catch(() => undefined)
              }}
              className="btn btn-ghost h-7 px-2 text-xs"
              title="读取剪贴板里的 .env 风格内容并按行解析"
            >
              从剪贴板贴入 .env
            </button>
          </div>
          <ul className="space-y-1.5">
            {pairs.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  className="input h-9 flex-[0_0_38%] font-mono"
                  value={p.k}
                  onChange={(e) => setPair(i, { k: e.target.value })}
                  placeholder="KEY"
                />
                <input
                  className="input h-9 flex-1 font-mono"
                  type={p.reveal ? 'text' : 'password'}
                  value={p.v}
                  onChange={(e) => setPair(i, { v: e.target.value })}
                  placeholder={looksLikeSecretKey(p.k) ? maskValue(p.v) || '••••' : 'value'}
                />
                <button
                  onClick={() => setPair(i, { reveal: !p.reveal })}
                  className="btn btn-ghost h-9 w-9 px-0"
                  aria-label={p.reveal ? 'Hide value' : 'Reveal value'}
                  type="button"
                >
                  {p.reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => removePair(i)}
                  className="btn btn-ghost h-9 w-9 px-0 hover:text-bad"
                  aria-label="Remove"
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <button onClick={addPair} className="btn btn-ghost mt-2 h-8 px-2 text-xs">
            <Plus className="h-3.5 w-3.5" /> 添加键值
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3">
        {isEdit && onDeleted ? (
          <button
            onClick={() => {
              if (vault && confirm(`确认删除草稿 "${vault.name}"?`)) {
                removeVault(vault.id)
                onDeleted()
              }
            }}
            className="btn btn-ghost text-xs hover:text-bad"
          >
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
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

// ─────────────────────────────────────────────────────────────────────────────
// shared
// ─────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: React.ReactNode
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          {label}
          {required && <span className="ml-0.5 text-accent">*</span>}
        </span>
        {hint && <span className="text-[10px] text-ink-dim">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
