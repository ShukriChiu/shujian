import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  buildPlan,
  maskValue,
  parseDotenv,
  type PlanRow,
} from '@/lib/dotenvParse'
import {
  genVaultId,
  loadVault,
  looksLikeSecretKey,
  maskValue as maskLocalValue,
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
            租户级凭证。两边都 AES-256-GCM 加密落库（KEK 在 backend 进程外，Railway env，未来可换 KMS）。
            服务端 Vaults 走 secret + scope + persona 流水线（启动时按 scope 解密成短时 envVars 注入）；
            Agent Vaults 是简单 envVar 包，启动 cursor agent 时整包注入，跨设备同步。
          </p>
        </div>
      </div>

      <nav className="mt-3 border-b border-line px-6">
        <div className="flex gap-1 text-xs font-medium">
          <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
            服务端 Vaults
          </TabButton>
          <TabButton active={tab === 'local'} onClick={() => setTab('local')}>
            Agent Vaults
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
  const bulkOpen = params.get('bulk') === '1'

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
    next.delete('bulk')
    next.set('new', '1')
    setParams(next, { replace: true })
  }
  function openBulk() {
    const next = new URLSearchParams(params)
    next.delete('name')
    next.delete('new')
    next.set('bulk', '1')
    setParams(next, { replace: true })
  }
  function closeRail() {
    const next = new URLSearchParams(params)
    next.delete('name')
    next.delete('new')
    next.delete('bulk')
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
              onClick={openBulk}
              disabled={!kek?.configured}
              className="btn btn-ghost h-8 px-2 text-xs"
              title={!kek?.configured ? 'KEK 未配置，无法加密写入' : '从 .env 文本批量录入'}
            >
              <FileUp className="h-3.5 w-3.5" /> 批量导入
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

      {bulkOpen && kek?.configured && (
        <BulkImportDialog
          existingNames={new Set((secrets ?? []).map((s) => s.name))}
          onClose={closeRail}
          onImported={async () => {
            await refresh()
          }}
        />
      )}

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
// Bulk import dialog
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_TEXT = `# 把 .env / 钉钉 webhook / R2 凭证 等粘贴到这里
# 格式: KEY=value (支持 export / 引号 / 转义 / # 注释)
ONION_API_KEY="sk-..."
DATABASE_URL="postgresql://..."
R2_SECRET_ACCESS_KEY="..."
DINGTALK_BOT_CONFIGS="[{\\"name\\":\\"...\\",\\"webhook\\":\\"...\\"}]"
`

interface RowState {
  /** Per-row submit state. */
  status: 'idle' | 'busy' | 'ok' | 'fail'
  message?: string
}

function BulkImportDialog({
  existingNames,
  onClose,
  onImported,
}: {
  existingNames: ReadonlySet<string>
  onClose: () => void
  onImported: () => void | Promise<void>
}) {
  const [text, setText] = useState('')
  const [prefix, setPrefix] = useState('onion.')
  const [skipPublic, setSkipPublic] = useState(true)
  const [overwriteExisting, setOverwriteExisting] = useState(true)
  const [skipKeys, setSkipKeys] = useState<Set<string>>(new Set())
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [submitting, setSubmitting] = useState(false)

  const allRows = useMemo(() => {
    if (!text.trim()) return [] as PlanRow[]
    const pairs = parseDotenv(text)
    return buildPlan(pairs, { prefix, existingNames })
  }, [text, prefix, existingNames])

  // Rows we'll actually write — public-skipped if checkbox set, user-skipped, or
  // existing-row + overwrite=false.
  const eligibleRows = useMemo(
    () =>
      allRows.filter((r) => {
        if (skipKeys.has(r.srcKey)) return false
        if (skipPublic && r.isPublic) return false
        if (r.exists && !overwriteExisting) return false
        return true
      }),
    [allRows, skipKeys, skipPublic, overwriteExisting],
  )

  function toggleSkip(key: string) {
    setSkipKeys((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function loadFile(f: File) {
    const t = await f.text()
    setText(t)
  }

  async function submit() {
    if (eligibleRows.length === 0) return
    setSubmitting(true)
    setRowState((s) => {
      const next = { ...s }
      eligibleRows.forEach((r) => {
        next[r.name] = { status: 'busy' }
      })
      return next
    })

    // Sequential is fine here — 14 secrets at ~200ms each = ~3s, and the
    // visible per-row progress is more useful than a small parallel speedup.
    let ok = 0
    let fail = 0
    for (const r of eligibleRows) {
      try {
        await serverVaults.upsertSecret({
          name: r.name,
          value: r.value,
          kind: r.kind,
          description: 'imported via dashboard bulk',
        })
        setRowState((s) => ({ ...s, [r.name]: { status: 'ok' } }))
        ok += 1
      } catch (e) {
        const msg = e instanceof BackendError ? e.message : String(e)
        setRowState((s) => ({ ...s, [r.name]: { status: 'fail', message: msg } }))
        fail += 1
      }
    }
    setSubmitting(false)
    if (ok > 0) await onImported()
    if (fail === 0) {
      // Auto-close after a brief moment so the user sees the green ticks.
      setTimeout(onClose, 700)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-accent" />
            <span className="text-sm font-medium text-ink">批量导入 Secrets</span>
            <span className="text-xs text-ink-dim">
              · 解析 .env 文本，预览后一次性加密入库
            </span>
          </div>
          <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]">
          {/* Left: paste + options */}
          <div className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs">
              <span className="font-medium text-ink-muted">.env 文本</span>
              <label className="btn btn-ghost h-7 cursor-pointer px-2 text-xs">
                <FileUp className="h-3 w-3" /> 选文件
                <input
                  type="file"
                  className="sr-only"
                  accept=".env,.txt,text/plain"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) loadFile(f)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE_TEXT}
              spellCheck={false}
              className="min-h-[260px] flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-dim/60"
            />
            <div className="space-y-2 border-t border-line px-4 py-3 text-xs">
              <Field label="名称前缀" hint="lowercase + 末尾点（onion. / bridge. / shujian.）">
                <input
                  className="input h-8 font-mono"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toLowerCase())}
                  placeholder="onion."
                />
              </Field>
              <label className="flex cursor-pointer items-center gap-2 text-ink-muted">
                <input
                  type="checkbox"
                  checked={skipPublic}
                  onChange={(e) => setSkipPublic(e.target.checked)}
                />
                跳过公开常量
                <span className="text-ink-dim">
                  （*_BASE_URL / *_PUBLIC_URL / 普通 https URL）
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-ink-muted">
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  onChange={(e) => setOverwriteExisting(e.target.checked)}
                />
                覆盖已存在的同名 secret
              </label>
            </div>
          </div>

          {/* Right: preview table */}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs">
              <span className="font-medium text-ink-muted">
                解析预览
                <span className="ml-2 font-mono text-ink-dim">
                  parsed {allRows.length} · 待写入{' '}
                  <span className="text-ink">{eligibleRows.length}</span>
                </span>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
              {allRows.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-ink-dim">
                  在左侧粘贴 .env 文本即可看到预览
                </div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-surface text-[11px] text-ink-dim">
                    <tr className="border-b border-line">
                      <th className="px-3 py-2 text-left font-normal">写</th>
                      <th className="px-3 py-2 text-left font-normal">源 KEY</th>
                      <th className="px-3 py-2 text-left font-normal">→ 名称</th>
                      <th className="px-3 py-2 text-left font-normal">kind</th>
                      <th className="px-3 py-2 text-left font-normal">值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allRows.map((r) => {
                      const state = rowState[r.name]?.status ?? 'idle'
                      const userSkip = skipKeys.has(r.srcKey)
                      const publicSkip = skipPublic && r.isPublic
                      const collisionSkip = r.exists && !overwriteExisting
                      const skipped = userSkip || publicSkip || collisionSkip
                      return (
                        <tr
                          key={r.srcKey}
                          className={cn(
                            'border-b border-line/60',
                            skipped && 'opacity-50',
                          )}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={!userSkip}
                              onChange={() => toggleSkip(r.srcKey)}
                              disabled={submitting}
                              title={
                                publicSkip
                                  ? '默认按"公开常量"跳过'
                                  : collisionSkip
                                    ? '已存在，未勾选覆盖'
                                    : '取消勾选则跳过此条'
                              }
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-ink">{r.srcKey}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5 font-mono text-ink-muted">
                              <ChevronRight className="h-3 w-3 text-ink-dim" />
                              {r.name}
                              {r.exists && (
                                <span className="rounded bg-warn/10 px-1 text-[10px] text-warn">
                                  已存在
                                </span>
                              )}
                              {r.isPublic && skipPublic && (
                                <span className="rounded bg-ink-dim/10 px-1 text-[10px] text-ink-dim">
                                  public
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                            {r.kind}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <code className="max-w-[260px] truncate text-[11px] text-ink-dim">
                                {maskValue(r.value)}
                              </code>
                              <RowStatusIcon state={state} message={rowState[r.name]?.message} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-line bg-surface px-5 py-3 text-xs">
          <div className="flex items-center gap-3 text-ink-dim">
            <KeyRound className="h-3 w-3" />
            <span>
              所有写入会被当前 KEK 加密；plaintext 不会被列表 / 取详 接口返回。
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn btn-ghost" disabled={submitting}>
              取消
            </button>
            <button
              onClick={submit}
              disabled={submitting || eligibleRows.length === 0}
              className="btn btn-primary"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileUp className="h-3.5 w-3.5" />
              )}
              导入 {eligibleRows.length} 条
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function RowStatusIcon({ state, message }: { state: RowState['status']; message?: string }) {
  if (state === 'busy') return <Loader2 className="h-3 w-3 animate-spin text-ink-dim" />
  if (state === 'ok') return <Check className="h-3 w-3 text-good" />
  if (state === 'fail')
    return (
      <span title={message} className="flex items-center gap-1 text-bad">
        <AlertTriangle className="h-3 w-3" />
        <span className="text-[10px]">fail</span>
      </span>
    )
  return null
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

  // The list endpoint omits `envs` to skip per-row decryption. The
  // editor needs them, so prime the cache as soon as a row is selected.
  useEffect(() => {
    if (!selectedId) return
    const cached = vaults.find((v) => v.id === selectedId)
    if (!cached || cached.envsLoaded) return
    void loadVault(selectedId).catch((err) => {
      console.warn('[vaults] loadVault failed', err)
    })
  }, [selectedId, vaults])

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
            <ShieldCheck className="h-3 w-3" />
            服务端加密 · 多端同步
          </span>
        }
        actions={
          <button onClick={openNew} className="btn btn-primary">
            <Plus className="h-4 w-4" /> 新建 Vault
          </button>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-y-auto scroll-thin">
          {vaults.length === 0 ? (
            <div className="px-6 py-10">
              <EmptyState
                glyph={<KeyRound className="h-5 w-5" />}
                title="还没有 Agent Vault"
                hint={
                  <>
                    每个 Vault 是一包 envVar；启动 cursor agent 时整包注入到
                    云端 sandbox。值在后端 AES-256-GCM 加密落库，跨设备同步。
                  </>
                }
                action={
                  <button onClick={openNew} className="btn">
                    <Plus className="h-4 w-4" /> 新建 Vault
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
          {(v.envKeys?.length ?? Object.keys(v.envs).length)} keys
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

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function save() {
    if (saving) return
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
    setSaving(true)
    setSaveError(null)
    try {
      await upsertVault({
        id,
        name: name.trim() || (vault ? vault.name : 'untitled'),
        description: description.trim(),
        tags: tagsArr,
        envs,
      })
      onSaved(id)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
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
                  placeholder={looksLikeSecretKey(p.k) ? maskLocalValue(p.v) || '••••' : 'value'}
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
      {saveError && (
        <div className="border-t border-bad/30 bg-bad-tint px-5 py-2 text-[11.5px] text-bad">
          保存失败：{saveError}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3">
        {isEdit && onDeleted ? (
          <button
            onClick={async () => {
              if (!vault) return
              if (!confirm(`确认删除 "${vault.name}"?`)) return
              try {
                await removeVault(vault.id)
                onDeleted()
              } catch (err) {
                alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
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
          <button onClick={onClose} className="btn" disabled={saving}>
            取消
          </button>
          <button onClick={save} className="btn btn-primary" disabled={saving}>
            {saving ? '保存中…' : '保存'}
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
