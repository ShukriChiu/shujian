import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, ExternalLink, ShieldCheck, Sparkles } from 'lucide-react'
import { ArtifactPane } from './ArtifactPane'
import { WorkspaceChat } from './WorkspaceChat'
import { CapabilityRenderer } from './CapabilityRenderer'
import { useMockChat } from '@/views/agents/conversation/artifact/useMockChat'
import { useCursorChat } from '@/lib/useCursorChat'
import {
  serverPersonas,
  type ResolvedEnvVar,
  type ServerPersona,
} from '@/lib/serverPersonas'
import {
  bundleFromIssuance,
  envToRecord,
  isBundleExpired,
  readIssuanceBundle,
  saveIssuanceBundle,
} from '@/lib/issuanceBundle'
import { useCountdown } from '@/lib/useCountdown'
import { cn } from '@/lib/utils'

/**
 * Anthropic-Artifacts inspired analytics workspace, now persona-aware.
 *
 *   /workspace                       → mock chat + mock artifacts (demo)
 *   /workspace?agent=ag-…&persona=…  → real Cursor chat + persona's
 *                                      manifest-driven capabilities
 *
 * The right pane has two tabs in persona mode:
 *
 *   "面板"      — reads persona.capabilities[] (Persona Spec v1) and
 *                 dispatches each through CapabilityRenderer. Data
 *                 comes from manifest-declared http_get / http_post /
 *                 static sources, with auth headers materialized from
 *                 the issuance bundle. The dashboard never knows
 *                 onion-agent's business shapes.
 *
 *   "工具产物"   — the legacy artifact stream: every Cursor `tool_call`
 *                 result the agent emits during the conversation,
 *                 rendered through the existing JSON-render pipeline.
 */
export function WorkspaceView() {
  const [params] = useSearchParams()
  const agentId = params.get('agent')
  const personaSlug = params.get('persona')

  if (agentId && personaSlug) {
    return <PersonaWorkspace agentId={agentId} personaSlug={personaSlug} />
  }
  if (agentId) {
    return <AgentOnlyWorkspace agentId={agentId} />
  }
  return <MockWorkspace />
}

/* -------------------------------------------------------------------------- */
/* MODE A · mock workspace (no agent yet)                                      */
/* -------------------------------------------------------------------------- */

function MockWorkspace() {
  const chat = useMockChat()
  useEffect(() => {
    document.title = 'Workspace · Shujian'
  }, [])
  const handleClose = useCallback((id: string) => chat.removeArtifact(id), [chat])
  return (
    <div
      className="grid h-full min-h-0 w-full"
      style={{ gridTemplateColumns: 'minmax(380px, 0.45fr) minmax(0, 0.55fr)' }}
    >
      <div className="flex min-h-0 min-w-0 border-r border-line">
        <WorkspaceChat chat={chat} />
      </div>
      <div className="min-h-0 min-w-0">
        <ArtifactPane
          artifacts={chat.artifacts}
          activeId={chat.activeArtifactId}
          onSelect={chat.selectArtifact}
          onClose={handleClose}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MODE B · agent-only (no persona, real chat, generic artifact pane)          */
/* -------------------------------------------------------------------------- */

function AgentOnlyWorkspace({ agentId }: { agentId: string }) {
  const chat = useCursorChat({ agentId })
  useEffect(() => {
    document.title = `Workspace · ${agentId.slice(0, 8)}`
  }, [agentId])
  const handleClose = useCallback((id: string) => chat.removeArtifact(id), [chat])
  return (
    <div
      className="grid h-full min-h-0 w-full"
      style={{ gridTemplateColumns: 'minmax(380px, 0.45fr) minmax(0, 0.55fr)' }}
    >
      <div className="flex min-h-0 min-w-0 border-r border-line">
        <WorkspaceChat chat={chat} />
      </div>
      <div className="min-h-0 min-w-0">
        <ArtifactPane
          artifacts={chat.artifacts}
          activeId={chat.activeArtifactId}
          onSelect={chat.selectArtifact}
          onClose={handleClose}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MODE C · persona workspace                                                  */
/* -------------------------------------------------------------------------- */

function PersonaWorkspace({ agentId, personaSlug }: { agentId: string; personaSlug: string }) {
  const chat = useCursorChat({ agentId })
  const [tab, setTab] = useState<'panel' | 'tools'>('panel')

  // Load persona manifest (static).
  const persona = useQuery({
    queryKey: ['personas', personaSlug],
    queryFn: () => serverPersonas.get(personaSlug),
    staleTime: 60_000,
  })

  // Resolve env: prefer cached issuance bundle, otherwise mint fresh.
  const env = useResolvedEnv(agentId, personaSlug)

  useEffect(() => {
    document.title = persona.data
      ? `${persona.data.display_name} · Workspace`
      : 'Workspace · Shujian'
  }, [persona.data])

  const handleClose = useCallback((id: string) => chat.removeArtifact(id), [chat])

  return (
    <div
      className="grid h-full min-h-0 w-full"
      style={{ gridTemplateColumns: 'minmax(380px, 0.45fr) minmax(0, 0.55fr)' }}
    >
      <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
        <PersonaChrome
          persona={persona.data}
          loading={persona.isLoading}
          agentId={agentId}
          env={env}
        />
        <div className="min-h-0 flex-1">
          <WorkspaceChat chat={chat} />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <RightPaneTabs
          tab={tab}
          setTab={setTab}
          panelCount={persona.data?.capabilities?.length ?? 0}
          toolCount={chat.artifacts.length}
        />
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {tab === 'panel' &&
            (persona.data ? (
              <CapabilityRenderer
                capabilities={persona.data.capabilities ?? []}
                env={env.record}
                placement="workspace_main"
              />
            ) : env.error ? (
              <div className="m-5 rounded-md border border-bad/40 bg-bad-tint px-3 py-2 text-[12px] text-bad">
                {env.error}
              </div>
            ) : (
              <div className="m-5 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink-muted">
                loading persona…
              </div>
            ))}
          {tab === 'tools' && (
            <div className="h-full">
              <ArtifactPane
                artifacts={chat.artifacts}
                activeId={chat.activeArtifactId}
                onSelect={chat.selectArtifact}
                onClose={handleClose}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Persona chrome on the chat side                                             */
/* -------------------------------------------------------------------------- */

function PersonaChrome({
  persona,
  loading,
  agentId,
  env,
}: {
  persona: ServerPersona | undefined
  loading: boolean
  agentId: string
  env: ResolvedEnvState
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-4 py-2.5 backdrop-blur">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent">
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">
            {persona?.display_name ?? (loading ? 'loading…' : '(unknown persona)')}
          </span>
          {persona && (
            <Link
              to={`/personas?slug=${persona.slug}`}
              className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim hover:text-accent"
            >
              {persona.slug}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-muted">
          <span className="font-mono text-[10px] text-ink-dim">{agentId.slice(0, 12)}…</span>
          <span aria-hidden>·</span>
          <ShieldCheck className="h-3 w-3 text-ok" />
          <JwtCountdown expiresAt={env.minExpiresAt} />
        </div>
      </div>
    </header>
  )
}

function JwtCountdown({ expiresAt }: { expiresAt: number | null }) {
  const cd = useCountdown(expiresAt)
  if (expiresAt === null) {
    return <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-dim">no jwt</span>
  }
  return (
    <span
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.04em]',
        cd.expired ? 'text-bad' : cd.secondsLeft < 300 ? 'text-warn' : 'text-ink-dim',
      )}
      title={new Date(expiresAt * 1000).toLocaleString()}
    >
      jwt · {cd.label}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Right-pane tab bar                                                          */
/* -------------------------------------------------------------------------- */

function RightPaneTabs({
  tab,
  setTab,
  panelCount,
  toolCount,
}: {
  tab: 'panel' | 'tools'
  setTab: (t: 'panel' | 'tools') => void
  panelCount: number
  toolCount: number
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface/60 px-3 py-1.5 backdrop-blur">
      <Tab on={tab === 'panel'} onClick={() => setTab('panel')} icon={<Sparkles className="h-3 w-3" />} label="面板" count={panelCount} />
      <Tab on={tab === 'tools'} onClick={() => setTab('tools')} icon={<ExternalLink className="h-3 w-3" />} label="工具产物" count={toolCount} />
    </div>
  )
}

function Tab({
  on,
  onClick,
  icon,
  label,
  count,
}: {
  on: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-mono uppercase tracking-[0.06em] transition-colors',
        on ? 'bg-surface-2 text-ink' : 'text-ink-dim hover:bg-surface-2/60 hover:text-ink-muted',
      )}
    >
      <span className={cn('flex h-3.5 w-3.5 items-center justify-center', on ? 'text-accent' : '')}>{icon}</span>
      <span>{label}</span>
      <span className={cn('rounded text-[10px]', on ? 'text-accent' : 'text-ink-dim')}>{count}</span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Env resolution hook                                                         */
/* -------------------------------------------------------------------------- */

interface ResolvedEnvState {
  record: Record<string, string>
  rows: ResolvedEnvVar[]
  minExpiresAt: number | null
  error: string | null
  loading: boolean
}

function useResolvedEnv(agentId: string, personaSlug: string): ResolvedEnvState {
  const [state, setState] = useState<ResolvedEnvState>(() => {
    const cached = readIssuanceBundle(agentId)
    if (cached && !isBundleExpired(cached)) {
      return {
        record: envToRecord(cached.env),
        rows: cached.env,
        minExpiresAt: cached.minExpiresAt,
        error: null,
        loading: false,
      }
    }
    return { record: {}, rows: [], minExpiresAt: null, error: null, loading: true }
  })

  useEffect(() => {
    const cached = readIssuanceBundle(agentId)
    if (cached && !isBundleExpired(cached) && cached.personaSlug === personaSlug) return

    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    ;(async () => {
      try {
        // Direct workspace URL (no wizard) — mint a fresh issuance so
        // we have JWTs we can audit/revoke. preview-env?reveal also
        // works but doesn't write an audit row, so prefer issue.
        const issuance = await serverPersonas.issue(personaSlug, {
          bridge_name: 'workspace-direct',
          cursor_agent_id: agentId,
        })
        if (cancelled) return
        saveIssuanceBundle(bundleFromIssuance({ issuance, agentId, personaSlug }))
        setState({
          record: envToRecord(issuance.env),
          rows: issuance.env,
          minExpiresAt: issuance.min_expires_at,
          error: null,
          loading: false,
        })
      } catch (err) {
        if (cancelled) return
        // Fall back to reveal (read-only) so the workspace still works
        // when the user lacks issue permission.
        try {
          const preview = await serverPersonas.revealEnv(personaSlug)
          if (cancelled) return
          const earliest = preview.env
            .map((e) => e.expires_at ?? null)
            .filter((v): v is number => typeof v === 'number')
            .sort((a, b) => a - b)[0]
          setState({
            record: envToRecord(preview.env),
            rows: preview.env,
            minExpiresAt: earliest ?? null,
            error: null,
            loading: false,
          })
        } catch (fallbackErr) {
          setState({
            record: {},
            rows: [],
            minExpiresAt: null,
            error: (err instanceof Error ? err.message : String(err)) +
              ' / fallback: ' +
              (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)),
            loading: false,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, personaSlug])

  return useMemo(() => state, [state])
}
