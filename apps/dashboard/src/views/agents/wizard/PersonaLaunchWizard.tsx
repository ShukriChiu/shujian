/**
 * Three-step wizard for launching a Cloud Agent from a persona.
 *
 *   Step 1 · Pick persona — list `/v1/personas`. Cards show the spec
 *            badge, scope chips, and capability glyphs. There's also a
 *            "no persona / blank cloud agent" path that drops back to
 *            the legacy form (model + repo + vault env).
 *
 *   Step 2 · Preview env — call `previewEnv(slug)` to get masked rows;
 *            user can hit "reveal" to mint short-lived JWTs and see
 *            real values, plus customize cursor settings (model,
 *            repo, ref, autoPR) inherited from `cursor_settings`.
 *
 *   Step 3 · Launch — sequential pipeline:
 *               POST /v1/personas/:slug/issue       (audit + JWTs)
 *               POST cursor-bridge /agents          (envVars, cursor_settings)
 *               POST /v1/personas/issuances/:id/record-launch  (link)
 *            On success we cache the issuance bundle keyed by the
 *            cursor agent_id (sessionStorage) and call the parent's
 *            `onCreated(unifiedId)` so it can navigate to either the
 *            agents conversation or the workspace.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Bot,
  Check,
  ChevronLeft,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import { cursorApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useVaults } from '@/lib/useVaults'
import {
  serverPersonas,
  type CursorSettings,
  type PersonaPreview,
  type ResolvedEnvVar,
  type ServerPersona,
} from '@/lib/serverPersonas'
import { bundleFromIssuance, envToRecord, saveIssuanceBundle } from '@/lib/issuanceBundle'
import { useCountdown } from '@/lib/useCountdown'
import { makeId } from '../types'

type Step = 'pick' | 'preview' | 'launch'

interface Props {
  onClose: () => void
  /** Called after a successful launch; receives the unified `cursor:<id>`. */
  onCreated: (unifiedId: string, ctx: { personaSlug?: string; toWorkspace: boolean }) => void
}

export function PersonaLaunchWizard({ onClose, onCreated }: Props) {
  const personas = useQuery({
    queryKey: ['personas', 'list'],
    queryFn: () => serverPersonas.list(),
    staleTime: 15_000,
  })

  const [step, setStep] = useState<Step>('pick')
  const [pickedSlug, setPickedSlug] = useState<string | null>(null)
  // wizard's local override of cursor settings — starts from persona,
  // user can edit name/repo/ref/autoPR/model.
  const [overrides, setOverrides] = useState<{
    name: string
    model: string
    repoUrl: string
    startingRef: string
    autoCreatePR: boolean
    toWorkspace: boolean
  }>({
    name: '',
    model: '',
    repoUrl: '',
    startingRef: 'main',
    autoCreatePR: true,
    toWorkspace: true,
  })

  const picked = useMemo(
    () => personas.data?.find((p) => p.slug === pickedSlug) ?? null,
    [personas.data, pickedSlug],
  )

  // When a persona is picked, prime overrides from its cursor_settings.
  useEffect(() => {
    if (!picked) return
    setOverrides((cur) => ({
      ...cur,
      model: cur.model || (picked.cursor_settings.model as string) || 'claude-4.6-sonnet',
      repoUrl: cur.repoUrl || (picked.cursor_settings.repo_url as string) || '',
      startingRef: cur.startingRef || (picked.cursor_settings.starting_ref as string) || 'main',
      autoCreatePR:
        typeof picked.cursor_settings.auto_create_pr === 'boolean'
          ? (picked.cursor_settings.auto_create_pr as boolean)
          : cur.autoCreatePR,
    }))
  }, [picked])

  return (
    <div className="flex h-full flex-col animate-slide-rail">
      <Header step={step} onClose={onClose} />
      <Stepper step={step} hasPersona={!!picked} />

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {step === 'pick' && (
          <PickStep
            personas={personas.data ?? []}
            isLoading={personas.isLoading}
            error={personas.error as Error | null}
            picked={pickedSlug}
            onPick={(slug) => setPickedSlug(slug)}
            onSkipToLegacy={() => {
              setPickedSlug(null)
              setStep('preview')
            }}
          />
        )}
        {step === 'preview' && (
          <PreviewStep
            picked={picked}
            overrides={overrides}
            setOverrides={setOverrides}
          />
        )}
        {step === 'launch' && picked && (
          <LaunchStep
            picked={picked}
            overrides={overrides}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
        {step === 'launch' && !picked && (
          <LegacyLaunchStep
            overrides={overrides}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </div>

      <Footer
        step={step}
        canForward={step === 'pick' ? !!pickedSlug : step === 'preview'}
        canBack={step !== 'pick'}
        onBack={() => setStep((s) => (s === 'launch' ? 'preview' : 'pick'))}
        onForward={() => setStep((s) => (s === 'pick' ? 'preview' : 'launch'))}
        onClose={onClose}
        forwardLabel={step === 'preview' ? '启动 →' : '下一步 →'}
        forwardIcon={step === 'preview' ? <Zap className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
        hidePrimaryOnLaunch={step === 'launch'}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* shell chrome                                                                */
/* -------------------------------------------------------------------------- */

function Header({ step, onClose }: { step: Step; onClose: () => void }) {
  return (
    <div className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-medium text-ink">
          New Cloud Agent
          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
            {step}
          </span>
        </span>
      </div>
      <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function Stepper({ step, hasPersona }: { step: Step; hasPersona: boolean }) {
  const items: Array<{ id: Step; label: string }> = [
    { id: 'pick', label: '选 persona' },
    { id: 'preview', label: hasPersona ? '预览 envVars' : '配置参数' },
    { id: 'launch', label: '启动' },
  ]
  const idx = items.findIndex((i) => i.id === step)
  return (
    <ol className="flex items-center gap-1 border-b border-line bg-surface-2/30 px-5 py-2.5 text-[11px] font-mono uppercase tracking-[0.06em] text-ink-dim">
      {items.map((it, i) => {
        const active = i === idx
        const done = i < idx
        return (
          <li key={it.id} className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded-full border text-[9px]',
                done && 'border-accent bg-accent text-white',
                active && !done && 'border-accent text-accent',
                !active && !done && 'border-line text-ink-dim',
              )}
            >
              {done ? <Check className="h-2.5 w-2.5" /> : i + 1}
            </span>
            <span className={cn(active ? 'text-accent' : done ? 'text-ink-muted' : 'text-ink-dim')}>
              {it.label}
            </span>
            {i < items.length - 1 && (
              <span aria-hidden className="mx-1 text-ink-dim">
                ›
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Footer({
  step,
  canForward,
  canBack,
  onBack,
  onForward,
  onClose,
  forwardLabel,
  forwardIcon,
  hidePrimaryOnLaunch,
}: {
  step: Step
  canForward: boolean
  canBack: boolean
  onBack: () => void
  onForward: () => void
  onClose: () => void
  forwardLabel: string
  forwardIcon: ReactNode
  hidePrimaryOnLaunch: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3">
      <button
        type="button"
        disabled={!canBack}
        onClick={onBack}
        className={cn('btn btn-ghost h-8 px-2 text-[12px]', !canBack && 'invisible')}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        上一步
      </button>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="btn h-8 px-3 text-[12px]">
          取消
        </button>
        {!hidePrimaryOnLaunch && (
          <button
            type="button"
            disabled={!canForward}
            onClick={onForward}
            className="btn btn-primary h-8 px-3 text-[12px] disabled:opacity-50"
          >
            {forwardIcon}
            {forwardLabel}
          </button>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Step 1 · pick persona                                                       */
/* -------------------------------------------------------------------------- */

function PickStep({
  personas,
  isLoading,
  error,
  picked,
  onPick,
  onSkipToLegacy,
}: {
  personas: ServerPersona[]
  isLoading: boolean
  error: Error | null
  picked: string | null
  onPick: (slug: string) => void
  onSkipToLegacy: () => void
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-line bg-surface-2" />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-xs text-bad">
        {error.message}
      </div>
    )
  }
  return (
    <div className="space-y-3 p-5">
      <p className="text-[12px] leading-[1.6] text-ink-muted">
        Persona 决定了云端 agent 拿到哪些 envVars、能调哪些 onion 接口、跑哪个 system prompt。
        在 <a href="/personas" className="text-accent underline">/personas</a> 维护清单。
      </p>
      <div className="space-y-2">
        {personas.map((p, i) => (
          <PersonaCard
            key={p.id}
            persona={p}
            picked={picked === p.slug}
            onPick={() => onPick(p.slug)}
            indexDelay={i}
          />
        ))}
      </div>
      <div className="pt-2">
        <button
          type="button"
          onClick={onSkipToLegacy}
          className="group flex w-full items-center gap-2 rounded-lg border border-dashed border-line bg-transparent px-3.5 py-2.5 text-left text-[12px] text-ink-muted transition-all duration-150 ease-out-quart hover:border-accent/40 hover:bg-accent-tint hover:text-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>不绑 persona, 用旧版 envVars vault 启动</span>
          <ArrowRight className="ml-auto h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  )
}

function PersonaCard({
  persona,
  picked,
  onPick,
  indexDelay,
}: {
  persona: ServerPersona
  picked: boolean
  onPick: () => void
  indexDelay: number
}) {
  const capCount = persona.capabilities?.length ?? 0
  const layouts = new Set((persona.capabilities ?? []).map((c) => c.layout))
  return (
    <button
      type="button"
      onClick={onPick}
      style={{ animationDelay: `${Math.min(indexDelay * 40, 240)}ms` }}
      className={cn(
        'group flex w-full flex-col gap-2 rounded-lg border bg-surface px-4 py-3 text-left animate-block-in transition-all duration-150 ease-out-quart hover:-translate-y-px',
        picked
          ? 'border-accent bg-accent-tint shadow-ring-accent'
          : 'border-line hover:border-accent/40 hover:bg-surface-2',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-md',
            picked ? 'bg-accent text-white' : 'bg-surface-2 text-ink-muted group-hover:text-accent',
          )}
        >
          <Bot className="h-3 w-3" />
        </span>
        <span className="text-[13px] font-medium text-ink">{persona.display_name}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
          v{persona.spec_version || '1.0'}
        </span>
        {picked && <Check className="ml-auto h-3.5 w-3.5 text-accent" />}
      </div>
      {persona.description && (
        <p className="text-[12px] leading-[1.55] text-ink-muted line-clamp-2">{persona.description}</p>
      )}
      <div className="flex flex-wrap gap-1.5 text-[10px] font-mono uppercase tracking-[0.04em]">
        <span className="pill pill-muted">
          <ShieldCheck className="mr-1 h-2.5 w-2.5" />
          {persona.allowed_scopes.length} scopes
        </span>
        {capCount > 0 && (
          <span className="pill pill-accent">
            <Database className="mr-1 h-2.5 w-2.5" />
            {capCount} caps
          </span>
        )}
        {Array.from(layouts).slice(0, 3).map((l) => (
          <span key={l} className="pill pill-muted">{l}</span>
        ))}
      </div>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Step 2 · preview                                                             */
/* -------------------------------------------------------------------------- */

interface OverrideState {
  name: string
  model: string
  repoUrl: string
  startingRef: string
  autoCreatePR: boolean
  toWorkspace: boolean
}

function PreviewStep({
  picked,
  overrides,
  setOverrides,
}: {
  picked: ServerPersona | null
  overrides: OverrideState
  setOverrides: (cb: (cur: OverrideState) => OverrideState) => void
}) {
  if (!picked) {
    return <LegacyParamsStep overrides={overrides} setOverrides={setOverrides} />
  }
  return <PersonaPreviewStep picked={picked} overrides={overrides} setOverrides={setOverrides} />
}

function PersonaPreviewStep({
  picked,
  overrides,
  setOverrides,
}: {
  picked: ServerPersona
  overrides: OverrideState
  setOverrides: (cb: (cur: OverrideState) => OverrideState) => void
}) {
  const masked = useQuery({
    queryKey: ['persona', picked.slug, 'preview-env'],
    queryFn: () => serverPersonas.previewEnv(picked.slug),
  })
  const [revealed, setRevealed] = useState(false)
  const reveal = useQuery({
    queryKey: ['persona', picked.slug, 'reveal-env'],
    queryFn: () => serverPersonas.revealEnv(picked.slug),
    enabled: revealed,
    staleTime: 30_000,
  })
  const preview: PersonaPreview | undefined = revealed ? reveal.data : masked.data

  return (
    <div className="space-y-4 p-5">
      <section className="space-y-2">
        <SectionLabel
          icon={<Bot className="h-3 w-3" />}
          title="persona"
          right={
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
              {picked.slug}
            </span>
          }
        />
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-ink-muted">
          {picked.description || picked.display_name}
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel
          icon={<ShieldCheck className="h-3 w-3" />}
          title="env vars"
          right={
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.06em] transition-colors',
                revealed
                  ? 'border-warn/40 bg-warn-tint text-warn'
                  : 'border-line text-ink-muted hover:border-accent/40 hover:text-accent',
              )}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {revealed ? 'hide' : 'reveal'}
            </button>
          }
        />
        {(masked.isLoading || (revealed && reveal.isLoading)) && (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-3 text-[11px] text-ink-dim">
            <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
            {revealed ? 'minting JWTs…' : 'loading masked env…'}
          </div>
        )}
        {(masked.error || (revealed && reveal.error)) && (
          <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[11px] text-bad">
            {((masked.error as Error) || (reveal.error as Error)).message}
          </div>
        )}
        {preview && (
          <div className="space-y-1.5">
            {preview.env.map((e) => (
              <EnvRow key={e.env} entry={e} revealed={revealed} />
            ))}
            {preview.errors.length > 0 && (
              <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[11px] text-bad">
                {preview.errors.map((er, i) => <div key={i}>· {er}</div>)}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel icon={<Zap className="h-3 w-3" />} title="cursor settings" />
        <CursorOverridesForm overrides={overrides} setOverrides={setOverrides} />
      </section>
    </div>
  )
}

function EnvRow({ entry, revealed }: { entry: ResolvedEnvVar; revealed: boolean }) {
  const cd = useCountdown(entry.expires_at ?? null)
  const expiring = entry.expires_at !== null && entry.expires_at !== undefined
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[11.5px]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-ink">{entry.env}</span>
          <span className="pill pill-muted text-[9px] normal-case">{entry.kind}</span>
          {entry.readonly && (
            <span className="pill pill-ok text-[9px] normal-case">readonly</span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-ink-muted">
          {revealed && entry.value
            ? entry.value.length > 64
              ? entry.value.slice(0, 32) + '…' + entry.value.slice(-12)
              : entry.value
            : entry.value
              ? '••••••••'
              : `(${entry.value_len} chars)`}
        </div>
      </div>
      <div className="self-center text-right">
        {expiring && (
          <div
            className={cn(
              'font-mono text-[10px] uppercase tracking-[0.04em]',
              cd.expired ? 'text-bad' : 'text-ink-dim',
            )}
            title={entry.expires_at ? new Date(entry.expires_at * 1000).toLocaleString() : ''}
          >
            {cd.label}
          </div>
        )}
        {!expiring && entry.value_len > 0 && (
          <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-dim">
            {entry.value_len} chars
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Step 3 · launch                                                              */
/* -------------------------------------------------------------------------- */

function LaunchStep({
  picked,
  overrides,
  onClose,
  onCreated,
}: {
  picked: ServerPersona
  overrides: OverrideState
  onClose: () => void
  onCreated: (unifiedId: string, ctx: { personaSlug?: string; toWorkspace: boolean }) => void
}) {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<'idle' | 'issuing' | 'launching' | 'recording' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  // Auto-fire the launch pipeline on mount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        setPhase('issuing')
        const issuance = await serverPersonas.issue(picked.slug, {
          bridge_name: 'cursor-bridge',
        })
        if (cancelled) return
        const envVars = envToRecord(issuance.env)

        setPhase('launching')
        const cs = mergeCursorSettings(picked.cursor_settings, overrides)
        const cursorAgent = await cursorApi.create({
          runtime: (cs.runtime as 'cloud' | 'local') ?? 'cloud',
          model: cs.model,
          name: overrides.name.trim() || `${picked.slug}-${Date.now().toString(36).slice(-4)}`,
          repoUrl: cs.repo_url || undefined,
          startingRef: cs.starting_ref || undefined,
          autoCreatePR: cs.auto_create_pr ?? true,
          settingSources: cs.setting_sources as Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'> | undefined,
          envVars,
        })
        if (cancelled) return

        setPhase('recording')
        try {
          await serverPersonas.recordLaunch(issuance.id, {
            bridge_name: 'cursor-bridge',
            cursor_agent_id: cursorAgent.agentId,
          })
        } catch (recErr) {
          // Audit-link is best-effort; the agent is already running.
          console.warn('[wizard] record-launch failed', recErr)
        }
        if (cancelled) return

        // Cache the env bundle so the workspace doesn't have to mint again.
        saveIssuanceBundle(
          bundleFromIssuance({
            issuance,
            agentId: cursorAgent.agentId,
            personaSlug: picked.slug,
          }),
        )
        qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
        qc.invalidateQueries({ queryKey: ['personas'] })
        setPhase('done')
        onCreated(makeId('cursor', cursorAgent.agentId), {
          personaSlug: picked.slug,
          toWorkspace: overrides.toWorkspace,
        })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [picked, overrides, onCreated, qc])

  return (
    <div className="space-y-3 p-5">
      <SectionLabel icon={<Zap className="h-3 w-3" />} title="launch pipeline" />
      <ol className="space-y-1.5">
        <PipelineRow
          label="POST /v1/personas/issue"
          hint="审计 + JWT minting"
          done={phase !== 'idle' && phase !== 'issuing'}
          active={phase === 'issuing'}
          failed={phase === 'error'}
        />
        <PipelineRow
          label="POST cursor-bridge /agents"
          hint="云端 agent 注入 envVars"
          done={phase === 'recording' || phase === 'done'}
          active={phase === 'launching'}
          failed={phase === 'error'}
        />
        <PipelineRow
          label="POST /v1/personas/issuances/:id/record-launch"
          hint="把 cursor_agent_id 关联回审计"
          done={phase === 'done'}
          active={phase === 'recording'}
          failed={phase === 'error'}
        />
      </ol>
      {error && (
        <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[11.5px] text-bad">
          {error}
          <div className="mt-2">
            <button onClick={onClose} className="btn h-7 px-2 text-[11px]">
              关闭
            </button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="rounded-md border border-ok/40 bg-ok-tint px-3 py-2 text-[11.5px] text-ok">
          <Check className="mr-1 inline h-3 w-3" />
          已启动 — 正在跳转 {overrides.toWorkspace ? 'workspace' : 'agent'}…
        </div>
      )}
    </div>
  )
}

function PipelineRow({
  label,
  hint,
  done,
  active,
  failed,
}: {
  label: string
  hint: string
  done: boolean
  active: boolean
  failed: boolean
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[11.5px]">
      <span
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
          done && 'bg-ok/15 text-ok',
          active && 'bg-accent/15 text-accent',
          failed && !done && 'bg-bad/15 text-bad',
          !done && !active && !failed && 'bg-surface-2 text-ink-dim',
        )}
      >
        {active ? <Loader2 className="h-3 w-3 animate-spin" /> : done ? <Check className="h-3 w-3" /> : '·'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-ink">{label}</div>
        <div className="text-[11px] text-ink-dim">{hint}</div>
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Legacy fallback path (no persona)                                           */
/* -------------------------------------------------------------------------- */

function LegacyParamsStep({
  overrides,
  setOverrides,
}: {
  overrides: OverrideState
  setOverrides: (cb: (cur: OverrideState) => OverrideState) => void
}) {
  return (
    <div className="space-y-4 p-5">
      <p className="text-[12px] leading-[1.55] text-ink-muted">
        没选 persona, 走原 envVars vault 路径。Vault 在
        <a href="/vaults" className="ml-1 text-accent underline">/vaults</a>
        管理。
      </p>
      <CursorOverridesForm overrides={overrides} setOverrides={setOverrides} legacy />
    </div>
  )
}

function LegacyLaunchStep({
  overrides,
  onClose,
  onCreated,
}: {
  overrides: OverrideState
  onClose: () => void
  onCreated: (unifiedId: string, ctx: { personaSlug?: string; toWorkspace: boolean }) => void
}) {
  const qc = useQueryClient()
  const vaults = useVaults()
  const startedRef = useRef(false)
  const [phase, setPhase] = useState<'idle' | 'launching' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        setPhase('launching')
        // legacy vault selector wasn't surfaced in this wizard yet; respect
        // first vault if present (matches old NewAgentRail default-empty behavior).
        const envVars = vaults[0]?.envs
        const ag = await cursorApi.create({
          runtime: 'cloud',
          model: overrides.model || 'claude-4.6-sonnet',
          name: overrides.name.trim() || undefined,
          repoUrl: overrides.repoUrl.trim() || undefined,
          startingRef: overrides.startingRef.trim() || undefined,
          autoCreatePR: overrides.autoCreatePR,
          envVars,
        })
        if (cancelled) return
        qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
        setPhase('done')
        onCreated(makeId('cursor', ag.agentId), { toWorkspace: overrides.toWorkspace })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [overrides, vaults, onCreated, qc])

  return (
    <div className="space-y-3 p-5">
      <SectionLabel icon={<Zap className="h-3 w-3" />} title="launch (legacy)" />
      <PipelineRow
        label="POST cursor-bridge /agents"
        hint="无 persona, vault 注入"
        done={phase === 'done'}
        active={phase === 'launching'}
        failed={phase === 'error'}
      />
      {error && (
        <div className="rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[11.5px] text-bad">
          {error}
          <div className="mt-2">
            <button onClick={onClose} className="btn h-7 px-2 text-[11px]">
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Cursor overrides form                                                       */
/* -------------------------------------------------------------------------- */

function CursorOverridesForm({
  overrides,
  setOverrides,
  legacy,
}: {
  overrides: OverrideState
  setOverrides: (cb: (cur: OverrideState) => OverrideState) => void
  legacy?: boolean
}) {
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

  return (
    <form className="space-y-3" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <Field label="名称（可选）" hint="留空 Cursor 会自动起一个">
        <input
          className="input"
          value={overrides.name}
          onChange={(e) => setOverrides((cur) => ({ ...cur, name: e.target.value }))}
          placeholder={legacy ? 'register-billing-fix' : 'boss-analyst-q3'}
        />
      </Field>
      <Field label="模型">
        <select
          className="select"
          value={overrides.model}
          onChange={(e) => setOverrides((cur) => ({ ...cur, model: e.target.value }))}
        >
          {(models.data ?? [{ id: 'claude-4.6-sonnet', displayName: 'Claude 4.6 Sonnet' }]).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName ?? m.id}
            </option>
          ))}
        </select>
      </Field>
      <Field label="仓库 URL" hint="从已授权列表选, 或粘贴一个">
        <input
          className="input"
          value={overrides.repoUrl}
          onChange={(e) => setOverrides((cur) => ({ ...cur, repoUrl: e.target.value }))}
          placeholder="https://github.com/..."
          list="cursor-repos"
        />
        <datalist id="cursor-repos">
          {(repos.data?.items ?? []).map((r) => (
            <option key={r.url} value={r.url} />
          ))}
        </datalist>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="起始 ref">
          <input
            className="input"
            value={overrides.startingRef}
            onChange={(e) => setOverrides((cur) => ({ ...cur, startingRef: e.target.value }))}
            placeholder="main"
          />
        </Field>
        <Field label="开 PR" hint="结束时自动开 pull request">
          <label className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm">
            <input
              type="checkbox"
              checked={overrides.autoCreatePR}
              onChange={(e) => setOverrides((cur) => ({ ...cur, autoCreatePR: e.target.checked }))}
              className="h-3.5 w-3.5 accent-[oklch(var(--accent-l)_var(--accent-c)_var(--accent-h))]"
            />
            <span className="text-ink-muted">auto PR</span>
          </label>
        </Field>
      </div>
      <Field label="启动后跳转" hint="Workspace 适合数据分析, agents 适合写码">
        <div className="flex items-center gap-2">
          <SegOption
            label="workspace"
            on={overrides.toWorkspace}
            onClick={() => setOverrides((cur) => ({ ...cur, toWorkspace: true }))}
          />
          <SegOption
            label="agents"
            on={!overrides.toWorkspace}
            onClick={() => setOverrides((cur) => ({ ...cur, toWorkspace: false }))}
          />
        </div>
      </Field>
    </form>
  )
}

function SegOption({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-8 flex-1 rounded-md border text-[12px] font-mono uppercase tracking-[0.04em] transition-colors',
        on
          ? 'border-accent bg-accent-tint text-accent'
          : 'border-line bg-surface text-ink-muted hover:border-accent/40 hover:text-accent',
      )}
    >
      {label}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
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

function SectionLabel({
  icon,
  title,
  right,
}: {
  icon: ReactNode
  title: string
  right?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
        <span className="flex h-4 w-4 items-center justify-center rounded text-ink-dim">{icon}</span>
        <span>{title}</span>
      </div>
      {right}
    </div>
  )
}

function mergeCursorSettings(base: CursorSettings, overrides: OverrideState): CursorSettings {
  return {
    ...base,
    runtime: (base.runtime as 'cloud' | 'local') ?? 'cloud',
    model: overrides.model || (base.model as string) || 'claude-4.6-sonnet',
    repo_url: overrides.repoUrl || (base.repo_url as string) || undefined,
    starting_ref: overrides.startingRef || (base.starting_ref as string) || 'main',
    auto_create_pr: overrides.autoCreatePR,
  }
}
