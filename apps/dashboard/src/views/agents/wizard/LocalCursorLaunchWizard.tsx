/**
 * Create a Cursor agent with `runtime: local` on the active bridge machine.
 * The agent runs in bridge `DEFAULT_CWD` (or a user-supplied path).
 */

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Cpu, Loader2, X, Zap } from 'lucide-react'
import { cursorApi } from '@/lib/api'
import { makeId } from '../types'

interface Props {
  onClose: () => void
  onCreated: (unifiedId: string, ctx: { toWorkspace: boolean }) => void
}

export function LocalCursorLaunchWizard({ onClose, onCreated }: Props) {
  const qc = useQueryClient()
  const health = useQuery({
    queryKey: ['cursor', 'health'],
    queryFn: cursorApi.health,
    retry: 0,
  })
  const models = useQuery({
    queryKey: ['cursor', 'models'],
    queryFn: cursorApi.models,
    retry: 0,
  })

  const defaultCwd = health.data?.defaults?.cwd ?? ''
  const defaultModel = health.data?.defaults?.model ?? 'composer-2'

  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState('')
  const [toWorkspace, setToWorkspace] = useState(true)

  const effectiveModel = model || defaultModel
  const effectiveCwd = cwd.trim() || defaultCwd

  const launch = useMutation({
    mutationFn: async () =>
      cursorApi.create({
        runtime: 'local',
        model: effectiveModel,
        name: name.trim() || undefined,
        cwd: effectiveCwd || undefined,
      }),
    onSuccess: (ag) => {
      qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
      onCreated(makeId('cursor', ag.agentId), { toWorkspace })
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (launch.isPending) return
    launch.mutate()
  }

  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-ink-muted">
            <Cpu className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-medium text-ink">New Local Cursor Agent</span>
        </div>
        <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-thin p-5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            在 active bridge 所在机器上启动 Cursor local agent，直接读写本地目录、加载
            `.cursor/skills` 与 MCP 配置。需要 bridge 在线（本地或 Cloudflare Tunnel）。
          </p>

          {health.error && (
            <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-xs text-bad">
              bridge 离线：请确认 cursor-bridge 在跑（默认 <span className="font-mono">:8013</span>），且
              Settings → Bridges 里 active bridge 为 <span className="font-mono">/cursor</span> 并填好 API Key。
              {(health.error as Error).message ? (
                <span className="mt-1 block font-mono opacity-90">{(health.error as Error).message}</span>
              ) : null}
            </div>
          )}

          <Field label="显示名称" hint="可选">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-local"
              autoFocus
            />
          </Field>

          <Field label="模型">
            {models.data && models.data.length > 0 ? (
              <select
                className="select font-mono text-sm"
                value={effectiveModel}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input font-mono"
                value={effectiveModel}
                onChange={(e) => setModel(e.target.value)}
                placeholder={defaultModel}
              />
            )}
          </Field>

          <Field
            label="工作目录 (cwd)"
            hint="留空则用 bridge DEFAULT_CWD"
          >
            <input
              className="input font-mono text-sm"
              value={cwd || defaultCwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={defaultCwd || '/path/to/repo'}
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={toWorkspace}
              onChange={(e) => setToWorkspace(e.target.checked)}
              className="rounded border-line"
            />
            创建后直接进入 workspace 聊天
          </label>

          {launch.error && (
            <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-xs text-bad">
              {(launch.error as Error).message}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} className="btn">
            取消
          </button>
          <button
            type="submit"
            disabled={launch.isPending || !!health.error}
            className="btn btn-primary"
          >
            {launch.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {launch.isPending ? '启动中…' : '启动 Local Agent'}
            {!launch.isPending && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
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
