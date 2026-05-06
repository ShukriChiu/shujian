import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, KeyRound, Plus, Trash2, X } from 'lucide-react'
import {
  genVaultId,
  listVaults,
  looksLikeSecretKey,
  maskValue,
  removeVault,
  upsertVault,
  type Vault,
} from '@/lib/vaults'
import { useVaults } from '@/lib/useVaults'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

export function VaultsView() {
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
        title="Vaults"
        description="把 .env 内容打成命名包，创建 cloud agent 时一键注入到 envVars。仅本浏览器可见。"
        meta={
          <>
            <span className="font-mono">{vaults.length}</span>
            <span aria-hidden>·</span>
            <span className="text-ink-dim">本地存储</span>
          </>
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
                title="还没有 vault"
                hint={
                  <>
                    每个 vault = 一组键值（如 STRIPE_KEY / DATABASE_URL）。
                    <br />
                    创建后会出现在 “新建 Cloud Agent” 的 envVars 选项里。
                  </>
                }
                action={
                  <button onClick={openNew} className="btn btn-primary">
                    <Plus className="h-4 w-4" /> 创建第一个 vault
                  </button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {vaults.map((v) => (
                <VaultRow
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
              <VaultEditor
                key="new"
                onClose={closeRail}
                onSaved={(id) => selectVault(id)}
              />
            ) : selected ? (
              <VaultEditor
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

function VaultRow({ v, active, onSelect }: { v: Vault; active: boolean; onSelect: () => void }) {
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
          {v.description && <span className="truncate text-xs text-ink-dim">{v.description}</span>}
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

function VaultEditor({
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
        <span className="text-sm font-medium text-ink">{isEdit ? '编辑 Vault' : '新建 Vault'}</span>
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
              if (vault && confirm(`确认删除 vault "${vault.name}"?`)) {
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
