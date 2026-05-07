/**
 * Edit (= respawn) a Cursor cloud agent.
 *
 * Cursor cloud sandboxes are immutable: their repo + envVars are bound
 * at `Agent.create({ cloud })` time. To change them we have to dispose
 * the old agent and spawn a new one with the merged settings — the new
 * agent gets a fresh `agentId`, conversation history is gone.
 *
 * We surface this honestly to the user ("re-spawn agent") instead of
 * pretending it's an in-place edit, and notify the parent through
 * `onRespawned(newId)` so it can update the URL / cached selection.
 *
 * Used in two places:
 *   - `/agents` rail's CursorRail (config tab) — quick edit without
 *     leaving the list
 *   - `/workspace` chrome's "settings" sheet — edit while looking at
 *     the live conversation
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { cursorApi, type CursorAgentMeta } from '@/lib/api'
import { useVaults } from '@/lib/useVaults'
import { loadVault } from '@/lib/vaults'
import { cn } from '@/lib/utils'

interface Props {
  agentId: string
  onClose: () => void
  /** Called when the respawn succeeds with the new agent id. */
  onRespawned: (newAgentId: string) => void
}

export function AgentEditor({ agentId, onClose, onRespawned }: Props) {
  const qc = useQueryClient()
  const vaults = useVaults()
  const repos = useQuery({
    queryKey: ['cursor', 'repos'],
    queryFn: cursorApi.repos,
    retry: 0,
    staleTime: 60_000,
  })
  const models = useQuery({
    queryKey: ['cursor', 'models'],
    queryFn: cursorApi.models,
    retry: 0,
  })
  // Pull existing meta so the form starts pre-filled. Falls back to
  // empty state if the bridge restarted (in-memory `agentMeta` map gets
  // wiped on bridge restart — there's no persistence yet).
  const meta = useQuery({
    queryKey: ['cursor', 'meta', agentId],
    queryFn: () => cursorApi.meta(agentId),
    retry: 0,
  })

  const [model, setModel] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [startingRef, setStartingRef] = useState('main')
  const [vaultId, setVaultId] = useState('')

  // Find the vault whose env-key set matches the agent's current envVars.
  // Cheap heuristic — the list endpoint returns `envKeys` without
  // decrypting the values, so we can pre-select without paying for a
  // bunch of KEK round-trips. If multiple vaults share the same key set
  // we just leave it blank and let the user pick.
  useEffect(() => {
    const m = meta.data?.meta
    if (!m) return
    setModel(m.modelId ?? '')
    setRepoUrl(m.repoUrl ?? '')
    setStartingRef(m.startingRef ?? 'main')
    if (m.envVars && Object.keys(m.envVars).length > 0) {
      const targetKeys = Object.keys(m.envVars).sort().join(',')
      const matches = vaults.filter(
        (v) => (v.envKeys ?? []).slice().sort().join(',') === targetKeys,
      )
      if (matches.length === 1) setVaultId(matches[0]!.id)
    }
  }, [meta.data, vaults])

  const summary = useAgentSummary(meta.data?.meta)

  const respawn = useMutation({
    mutationFn: async () => {
      let envVars: Record<string, string> | undefined
      if (vaultId) {
        const cached = vaults.find((v) => v.id === vaultId)
        if (cached?.envsLoaded) {
          envVars = { ...cached.envs }
        } else {
          const loaded = await loadVault(vaultId)
          if (loaded) envVars = { ...loaded.envs }
        }
      }
      return cursorApi.update(agentId, {
        model: model || undefined,
        repoUrl: repoUrl.trim() || undefined,
        startingRef: startingRef.trim() || undefined,
        envVars,
      })
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
      qc.invalidateQueries({ queryKey: ['cursor', 'meta'] })
      onRespawned(res.agentId)
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    respawn.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex h-full flex-col">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-warn/15 text-warn">
            <RefreshCw className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-medium text-ink">编辑 agent</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost h-7 w-7 px-0"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 scroll-thin">
        <div className="rounded-md border border-warn/30 bg-warn-tint px-3 py-2 text-[11.5px] leading-[1.55] text-warn">
          <strong className="font-semibold">注意：</strong>cursor cloud sandbox 不支持原地改设置。点「保存并重启」会
          dispose 旧 agent，新启一个 —— 新 agent 是全新 id，<strong className="font-semibold">对话历史不会保留</strong>。
        </div>

        {summary && (
          <section className="space-y-2 rounded-md border border-line bg-surface-2/40 px-3 py-2.5">
            <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-dim">
              当前配置
            </div>
            {summary.rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3 text-[11.5px]">
                <span className="text-ink-dim">{r.label}</span>
                <span className={cn('truncate text-right text-ink', r.mono && 'font-mono')}>
                  {r.value}
                </span>
              </div>
            ))}
          </section>
        )}

        <Field label="模型">
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">— 不变 —</option>
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ?? m.id}
              </option>
            ))}
          </select>
        </Field>

        <Field label="仓库 URL" hint="只读：业务知识 / DATABASE.md 来源">
          <input
            className="input"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/..."
            list="cursor-repos-edit"
          />
          <datalist id="cursor-repos-edit">
            {(repos.data?.items ?? []).map((r) => (
              <option key={r.url} value={r.url} />
            ))}
          </datalist>
        </Field>

        <Field label="起始 ref" hint="cloud agent 跑完即丢分支，不会推回 GitHub">
          <input
            className="input"
            value={startingRef}
            onChange={(e) => setStartingRef(e.target.value)}
            placeholder="main"
          />
        </Field>

        <Field
          label="环境变量 vault"
          hint={
            vaults.length === 0
              ? '没有 vault, 在 /vaults 创建后回来选'
              : `${vaults.length} 个可选 · 重启后注入到新 sandbox`
          }
        >
          <select className="select" value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
            <option value="">— 不注入 envVars —</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.envKeys?.length ?? Object.keys(v.envs).length} keys)
              </option>
            ))}
          </select>
        </Field>

        {respawn.error && (
          <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[12px] text-bad">
            {(respawn.error as Error).message}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3">
        <button type="button" onClick={onClose} className="btn h-8 px-3 text-[12px]">
          取消
        </button>
        <button
          type="submit"
          disabled={respawn.isPending}
          className="btn btn-primary h-8 px-3 text-[12px]"
        >
          {respawn.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          保存并重启
        </button>
      </div>
    </form>
  )
}

function useAgentSummary(meta: CursorAgentMeta | undefined) {
  return useMemo(() => {
    if (!meta) return null
    const rows: Array<{ label: string; value: string; mono?: boolean }> = [
      { label: 'runtime', value: meta.runtime, mono: true },
      { label: 'model', value: meta.modelId, mono: true },
    ]
    if (meta.repoUrl) rows.push({ label: 'repo', value: meta.repoUrl, mono: true })
    if (meta.startingRef) rows.push({ label: 'ref', value: meta.startingRef, mono: true })
    if (meta.envVars && Object.keys(meta.envVars).length > 0) {
      const keys = Object.keys(meta.envVars)
      rows.push({
        label: 'envVars',
        value: `${keys.length} key${keys.length > 1 ? 's' : ''} · ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}`,
        mono: true,
      })
    }
    return { rows }
  }, [meta])
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
