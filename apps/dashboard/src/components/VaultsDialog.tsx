import { useEffect, useMemo, useState } from 'react'
import {
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Save,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  genVaultId,
  looksLikeSecretKey,
  removeVault,
  upsertVault,
  type Vault,
} from '@/lib/vaults'
import { useVaults } from '@/lib/useVaults'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

export function VaultsDialog({ open, onClose }: Props) {
  const vaults = useVaults()
  const [editingId, setEditingId] = useState<string | null>(null)

  const editing = useMemo(
    () => vaults.find((v) => v.id === editingId) ?? null,
    [vaults, editingId],
  )

  useEffect(() => {
    if (open && !editingId && vaults[0]) setEditingId(vaults[0].id)
  }, [open, editingId, vaults])

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
    const v: Vault = {
      id: genVaultId(),
      name: 'new-vault',
      description: '',
      envs: {},
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    upsertVault(v)
    setEditingId(v.id)
  }

  function remove(id: string) {
    removeVault(id)
    if (editingId === id) {
      const fallback = vaults.find((v) => v.id !== id)
      setEditingId(fallback?.id ?? null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative grid w-full max-w-3xl grid-cols-[220px_1fr] overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xl">
        <aside className="border-r border-ink-100 bg-ink-50/40">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-700">
              <KeyRound className="h-3 w-3" />
              Vaults
            </div>
            <button
              onClick={addNew}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-ink-600 hover:border-violet-300 hover:text-violet-700"
              title="新增 vault"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          <ul className="max-h-[480px] overflow-auto p-1.5">
            {vaults.length === 0 && (
              <li className="px-2 py-3 text-[11px] leading-snug text-ink-500">
                还没有 vault。点 <span className="font-mono">+</span> 新建第一个。
              </li>
            )}
            {vaults.map((v) => {
              const selected = editingId === v.id
              const keyCount = Object.keys(v.envs).length
              return (
                <li key={v.id}>
                  <button
                    onClick={() => setEditingId(v.id)}
                    className={cn(
                      'group mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
                      selected ? 'bg-white shadow-sm ring-1 ring-violet-200' : 'hover:bg-white/70',
                    )}
                  >
                    <KeyRound className="h-3 w-3 shrink-0 text-violet-600" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-ink-900">{v.name}</div>
                      <div className="truncate text-[10px] text-ink-500">
                        {keyCount} key{keyCount === 1 ? '' : 's'}
                        {v.tags && v.tags.length > 0 && (
                          <span className="ml-1 text-ink-400">· {v.tags.join(', ')}</span>
                        )}
                      </div>
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
                <KeyRound className="h-3.5 w-3.5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  {editing?.name ?? '— 选一个 vault —'}
                </div>
                <div className="font-mono text-[11px] text-ink-500">
                  {editing?.id ?? 'shujian.vaults · cloud agent envVars'}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {editing ? (
            <VaultEditor key={editing.id} vault={editing} onRemove={() => remove(editing.id)} />
          ) : (
            <div className="space-y-3 px-5 py-8 text-center text-[12px] text-ink-500">
              <div>左侧列表里挑一个 vault 编辑，或点上面的 + 新建。</div>
              <div className="text-[11px] leading-relaxed text-ink-400">
                Vault = 一组 env vars。绑到 Cursor cloud agent 后，会作为 process.env
                注入云端 VM。Cursor 加密保存，agent 销毁时一起清理。
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

interface KvRow {
  rid: string
  k: string
  v: string
  show: boolean
}

function VaultEditor({ vault, onRemove }: { vault: Vault; onRemove: () => void }) {
  const [name, setName] = useState(vault.name)
  const [description, setDescription] = useState(vault.description ?? '')
  const [tags, setTags] = useState((vault.tags ?? []).join(', '))
  const [rows, setRows] = useState<KvRow[]>(() => kvRowsFromEnvs(vault.envs))
  const [savedFlash, setSavedFlash] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')

  function addRow() {
    setRows((rs) => [...rs, { rid: rid(), k: '', v: '', show: false }])
  }

  function updateRow(rid: string, patch: Partial<KvRow>) {
    setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)))
  }

  function removeRow(rid: string) {
    setRows((rs) => rs.filter((r) => r.rid !== rid))
  }

  function save() {
    const envs: Record<string, string> = {}
    for (const r of rows) {
      const k = r.k.trim()
      if (!k) continue
      envs[k] = r.v
    }
    upsertVault({
      ...vault,
      name: name.trim() || vault.id,
      description: description.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      envs,
    })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1200)
  }

  function applyImport() {
    const parsed = parseDotenv(importText)
    if (Object.keys(parsed).length === 0) {
      setImportOpen(false)
      setImportText('')
      return
    }
    setRows((rs) => {
      const byKey = new Map(rs.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r] as const))
      for (const [k, v] of Object.entries(parsed)) {
        const existing = byKey.get(k)
        if (existing) {
          existing.v = v
        } else {
          byKey.set(k, { rid: rid(), k, v, show: false })
        }
      }
      // Preserve insertion order: keep the original order, then any new keys.
      const seen = new Set<string>()
      const result: KvRow[] = []
      for (const r of rs) {
        const key = r.k.trim()
        if (!key) {
          result.push(r)
          continue
        }
        if (!seen.has(key)) {
          seen.add(key)
          result.push(byKey.get(key)!)
        }
      }
      for (const [key, row] of byKey) {
        if (!seen.has(key)) {
          seen.add(key)
          result.push(row)
        }
      }
      return result
    })
    setImportOpen(false)
    setImportText('')
  }

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-db"
          />
        </Field>
        <Field label="Tags" hint="逗号分隔，如 prod, db">
          <div className="relative">
            <Tag className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-7"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="prod, db"
            />
          </div>
        </Field>
      </div>

      <Field label="Description (可选)">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="什么场景用、谁负责"
        />
      </Field>

      <div className="rounded-lg border border-ink-200 bg-ink-50/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-600">
            Env Vars · {rows.filter((r) => r.k.trim()).length}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setImportOpen((o) => !o)}
              className="btn btn-ghost h-7 text-[11px]"
              title="粘 .env 批量导入"
            >
              <Upload className="h-3 w-3" />
              导入 .env
            </button>
            <button onClick={addRow} className="btn btn-ghost h-7 text-[11px]">
              <Plus className="h-3 w-3" />
              加一行
            </button>
          </div>
        </div>

        {importOpen && (
          <div className="mb-3 space-y-2 rounded-md border border-violet-200 bg-violet-50/50 p-2">
            <textarea
              className="input min-h-[120px] font-mono text-[11px] leading-snug"
              placeholder={`DATABASE_URL=postgresql://...\nREDIS_URL=redis://...\nSTRIPE_KEY=sk_live_...`}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setImportOpen(false)
                  setImportText('')
                }}
                className="btn btn-ghost h-7 text-[11px]"
              >
                取消
              </button>
              <button onClick={applyImport} className="btn btn-primary h-7 text-[11px]">
                合并到下方
              </button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="py-3 text-center text-[11px] text-ink-500">
            还没有 env。点上面的「加一行」或「导入 .env」开始。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.rid} className="grid grid-cols-[1fr_2fr_auto] items-center gap-1.5">
                <input
                  className="input h-8 font-mono text-[11px]"
                  placeholder="DATABASE_URL"
                  value={r.k}
                  onChange={(e) => updateRow(r.rid, { k: e.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <KvSecretInput
                  value={r.v}
                  show={r.show}
                  onShow={(show) => updateRow(r.rid, { show })}
                  onChange={(v) => updateRow(r.rid, { v })}
                  isSecret={!!r.k && looksLikeSecretKey(r.k)}
                />
                <button
                  onClick={() => removeRow(r.rid)}
                  className="rounded-md p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600"
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
        <button
          onClick={onRemove}
          className="btn btn-ghost h-8 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-3 w-3" />
          删除 vault
        </button>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'text-[11px] text-emerald-600 transition',
              savedFlash ? 'opacity-100' : 'opacity-0',
            )}
          >
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

function KvSecretInput({
  value,
  onChange,
  show,
  onShow,
  isSecret,
}: {
  value: string
  onChange: (v: string) => void
  show: boolean
  onShow: (b: boolean) => void
  isSecret: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type={show || !isSecret ? 'text' : 'password'}
        className="input h-8 flex-1 font-mono text-[11px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {isSecret && (
        <button
          type="button"
          onClick={() => onShow(!show)}
          className="btn btn-ghost h-8 px-1.5 shrink-0"
          title={show ? '隐藏' : '显示'}
        >
          {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      )}
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
    <div>
      <label className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
        <span className="font-mono">{label}</span>
      </label>
      {children}
      {hint && <div className="mt-1 text-[11px] leading-snug text-ink-500">{hint}</div>}
    </div>
  )
}

function rid(): string {
  return `r_${Math.random().toString(36).slice(2, 8)}`
}

function kvRowsFromEnvs(envs: Record<string, string>): KvRow[] {
  return Object.entries(envs).map(([k, v]) => ({ rid: rid(), k, v, show: false }))
}

// Tolerant .env parser. Handles `KEY=value`, optional `export ` prefix,
// `#` comments (full-line and trailing-on-unquoted), single/double-quoted
// values, escapes inside double quotes (\n, \r, \t, \", \\), and ignores
// blank lines. Doesn't try to be a full POSIX shell.
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const stripped = line.startsWith('export ') ? line.slice(7) : line
    const eq = stripped.indexOf('=')
    if (eq <= 0) continue
    const key = stripped.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = stripped.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    out[key] = value
  }
  return out
}
