/**
 * AI Persona管理页 — list + editor + reveal preview.
 *
 * Editor offers two modes:
 *   - Form: fields + scope multi-select + capabilities table
 *   - YAML: paste a persona YAML matching personas/spec/persona.schema.json
 *           and persist verbatim. Useful for round-trips with the
 *           personas/*.yaml files in the repo (see PERSONA_SPEC.md).
 *
 * Preview pane lives inline once a persona is selected:
 *   - Default: masked envVars + jti countdown stays empty
 *   - Reveal: hits backend with ?reveal=true (mints JWT, decrypts).
 *             Surfaced behind an explicit button + warning, since each
 *             reveal burns a JWT.
 *
 * Capabilities table is read-only here; it's edited via YAML mode (the
 * spec is rich enough that a form would be a 600-line wall, while YAML
 * is the canonical source anyway).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { BackendError } from '@/lib/backend'
import { serverVaults, type VaultScope } from '@/lib/serverVaults'
import {
  formatField,
  maskRevealedValue,
  serverPersonas,
  type PersonaCapability,
  type PersonaPreview,
  type ResolvedEnvVar,
  type ServerPersona,
  type UpsertPersonaBody,
} from '@/lib/serverPersonas'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

export function PersonasView() {
  const [params, setParams] = useSearchParams()
  const selectedSlug = params.get('slug')
  const newOpen = params.get('new') === '1'

  const [personas, setPersonas] = useState<ServerPersona[] | null>(null)
  const [scopes, setScopes] = useState<VaultScope[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setLoadErr(null)
    try {
      const [list, sc] = await Promise.all([
        serverPersonas.list(),
        serverVaults.listScopes(),
      ])
      setPersonas(list)
      setScopes(sc)
    } catch (e) {
      setLoadErr(e instanceof BackendError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selected = personas?.find((p) => p.slug === selectedSlug) ?? null

  function selectPersona(slug: string | null) {
    const next = new URLSearchParams(params)
    if (slug) next.set('slug', slug)
    else next.delete('slug')
    next.delete('new')
    setParams(next, { replace: true })
  }
  function openNew() {
    const next = new URLSearchParams(params)
    next.delete('slug')
    next.set('new', '1')
    setParams(next, { replace: true })
  }
  function closeRail() {
    const next = new URLSearchParams(params)
    next.delete('slug')
    next.delete('new')
    setParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="AI Personas"
        description="一份 YAML 定义一个 AI 身份：能干什么、用哪个角色的数据、用什么模型、看哪几张面板。Spec 见 personas/PERSONA_SPEC.md。"
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
            <button onClick={openNew} className="btn btn-primary">
              <Plus className="h-4 w-4" /> 新建 Persona
            </button>
          </>
        }
      />

      {loadErr && (
        <div className="mx-6 mb-3 flex items-start gap-2 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">无法加载 personas</div>
            <div className="mt-0.5 font-mono text-[11px]">{loadErr}</div>
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="overflow-y-auto scroll-thin">
          {personas === null && !loadErr ? (
            <div className="px-6 py-10 text-center text-xs text-ink-dim">加载中…</div>
          ) : personas && personas.length === 0 ? (
            <div className="px-6 py-10">
              <EmptyState
                glyph={<Bot className="h-5 w-5" />}
                title="还没有 persona"
                hint={
                  <>
                    每个 persona = 一份身份契约（slug + scopes + capabilities）。
                    <br />
                    可以在仓库里写 personas/&lt;slug&gt;.yaml 后跑{' '}
                    <span className="text-ink">persona_sync.py --bootstrap</span>，
                    <br />
                    或者点右上角直接在浏览器里建一个。
                  </>
                }
                action={
                  <button onClick={openNew} className="btn btn-primary">
                    <Plus className="h-4 w-4" /> 创建第一个 persona
                  </button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {(personas ?? []).map((p) => (
                <PersonaRow
                  key={p.id}
                  p={p}
                  scopes={scopes ?? []}
                  active={p.slug === selectedSlug}
                  onSelect={() => selectPersona(p.slug)}
                />
              ))}
            </ul>
          )}
        </div>

        {(selected || newOpen) && (
          <aside className="hidden border-l border-line bg-surface xl:flex xl:flex-col">
            <PersonaEditor
              key={selected?.slug ?? 'new'}
              persona={selected ?? undefined}
              scopes={scopes ?? []}
              onClose={closeRail}
              onSaved={async (slug) => {
                await refresh()
                selectPersona(slug)
              }}
              onDeleted={async () => {
                await refresh()
                closeRail()
              }}
            />
          </aside>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// List row
// ─────────────────────────────────────────────────────────────────────────────

function PersonaRow({
  p,
  scopes,
  active,
  onSelect,
}: {
  p: ServerPersona
  scopes: VaultScope[]
  active: boolean
  onSelect: () => void
}) {
  const scopeNames = useMemo(() => {
    const byId = new Map(scopes.map((s) => [s.id, s.name]))
    return p.allowed_scopes.map((id) => byId.get(id) ?? id.slice(0, 8))
  }, [p.allowed_scopes, scopes])

  return (
    <li>
      <button
        onClick={onSelect}
        className={cn(
          'group flex w-full items-center gap-3 px-6 py-3 text-left transition-colors',
          active ? 'bg-surface-2' : 'hover:bg-surface-2/60',
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink-dim">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-ink">{p.display_name}</span>
            <span className="font-mono text-[11px] text-ink-dim">{p.slug}</span>
            {p.spec_version !== '1.0' && (
              <span className="rounded border border-line px-1 font-mono text-[10px] text-ink-dim">
                v{p.spec_version}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
            {p.domain && <span>· {p.domain}</span>}
            <span>· {scopeNames.length} scope{scopeNames.length === 1 ? '' : 's'}</span>
            <span>· {p.capabilities.length} capability(ies)</span>
            {scopeNames.slice(0, 3).map((n) => (
              <span key={n} className="rounded bg-surface-2 px-1.5">{n}</span>
            ))}
            {scopeNames.length > 3 && <span>+{scopeNames.length - 3}</span>}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-ink-dim opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor (form + YAML modes) + preview pane
// ─────────────────────────────────────────────────────────────────────────────

type EditMode = 'form' | 'yaml'

function PersonaEditor({
  persona,
  scopes,
  onClose,
  onSaved,
  onDeleted,
}: {
  persona?: ServerPersona
  scopes: VaultScope[]
  onClose: () => void
  onSaved: (slug: string) => void | Promise<void>
  onDeleted?: () => void | Promise<void>
}) {
  const isNew = !persona
  const [mode, setMode] = useState<EditMode>('form')

  // Form state
  const [slug, setSlug] = useState(persona?.slug ?? '')
  const [displayName, setDisplayName] = useState(persona?.display_name ?? '')
  const [description, setDescription] = useState(persona?.description ?? '')
  const [domain, setDomain] = useState(persona?.domain ?? '')
  const [systemPrompt, setSystemPrompt] = useState(persona?.system_prompt ?? '')
  const [allowedScopes, setAllowedScopes] = useState<string[]>(persona?.allowed_scopes ?? [])
  const [cursorJson, setCursorJson] = useState(
    JSON.stringify(persona?.cursor_settings ?? defaultCursorSettings(), null, 2),
  )
  const [capabilitiesJson, setCapabilitiesJson] = useState(
    JSON.stringify(persona?.capabilities ?? [], null, 2),
  )

  // YAML mode state
  const [yamlText, setYamlText] = useState('')
  const [yamlBusy, setYamlBusy] = useState(false)
  const [yamlImportErr, setYamlImportErr] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  // Reveal preview state
  const [preview, setPreview] = useState<PersonaPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewRevealed, setPreviewRevealed] = useState(false)

  const loadPreview = useCallback(
    async (reveal: boolean) => {
      if (!persona) return
      setPreviewBusy(true)
      setErr(null)
      try {
        const p = reveal
          ? await serverPersonas.revealEnv(persona.slug)
          : await serverPersonas.previewEnv(persona.slug)
        setPreview(p)
        setPreviewRevealed(reveal)
      } catch (e) {
        setErr(e instanceof BackendError ? e.message : String(e))
      } finally {
        setPreviewBusy(false)
      }
    },
    [persona],
  )

  // Auto-load masked preview when an existing persona is opened.
  useEffect(() => {
    if (persona) loadPreview(false)
  }, [persona, loadPreview])

  function buildBodyFromForm(): UpsertPersonaBody {
    let cursorSettings: Record<string, unknown>
    try {
      cursorSettings = JSON.parse(cursorJson || '{}')
    } catch (e) {
      throw new Error(`cursor_settings 不是合法 JSON: ${(e as Error).message}`)
    }
    let capabilities: PersonaCapability[]
    try {
      capabilities = JSON.parse(capabilitiesJson || '[]')
    } catch (e) {
      throw new Error(`capabilities 不是合法 JSON: ${(e as Error).message}`)
    }
    if (!Array.isArray(capabilities)) {
      throw new Error('capabilities 必须是数组')
    }
    return {
      slug: slug.trim().toLowerCase(),
      display_name: displayName.trim(),
      description: description?.trim() || null,
      system_prompt: systemPrompt,
      allowed_scopes: allowedScopes,
      cursor_settings: cursorSettings,
      domain: domain?.trim() || null,
      capabilities,
    }
  }

  async function save() {
    setBusy(true)
    setErr(null)
    setOkMsg(null)
    try {
      const body = buildBodyFromForm()
      if (!body.slug) throw new Error('slug 必填')
      if (!body.display_name) throw new Error('display_name 必填')
      if (!body.system_prompt) throw new Error('system_prompt 必填')
      const saved = await serverPersonas.upsert(body)
      setOkMsg(`saved (id=${saved.id.slice(0, 8)}…)`)
      await onSaved(saved.slug)
    } catch (e) {
      setErr(e instanceof BackendError ? e.message : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteIt() {
    if (!persona) return
    if (!confirm(`确定删除 persona '${persona.slug}'?`)) return
    setBusy(true)
    setErr(null)
    try {
      await serverPersonas.delete(persona.slug)
      await onDeleted?.()
    } catch (e) {
      setErr(e instanceof BackendError ? e.message : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** YAML-mode save: parse client-side then upsert. We deliberately use
   *  the server's allowed_scopes UUIDs (not names from YAML) — name → id
   *  resolution is a separate concern owned by personas/scripts/persona_sync.py.
   *  In-browser YAML mode is for "edit what backend already has" round-trips. */
  async function saveFromYaml() {
    setYamlBusy(true)
    setYamlImportErr(null)
    setErr(null)
    setOkMsg(null)
    try {
      const parsed = parseSimpleYaml(yamlText)
      if (typeof parsed !== 'object' || !parsed)
        throw new Error('YAML root must be a mapping')
      const o = parsed as Record<string, unknown>
      const body: UpsertPersonaBody = {
        slug: String(o.slug ?? '').toLowerCase(),
        display_name: String(o.display_name ?? ''),
        description: typeof o.description === 'string' ? o.description : null,
        system_prompt: String(o.system_prompt ?? ''),
        // YAML uses scope names; we need UUIDs. Resolve against the
        // currently-loaded scopes list.
        allowed_scopes: resolveScopeIds(o.allowed_scopes, scopes),
        cursor_settings: (o.cursor_settings as Record<string, unknown>) ?? {},
        domain: typeof o.domain === 'string' ? o.domain : null,
        spec_version: typeof o.spec_version === 'string' ? o.spec_version : '1.0',
        capabilities: (o.capabilities as PersonaCapability[]) ?? [],
      }
      const saved = await serverPersonas.upsert(body)
      setOkMsg(`saved from YAML (id=${saved.id.slice(0, 8)}…)`)
      await onSaved(saved.slug)
    } catch (e) {
      setYamlImportErr(e instanceof BackendError ? e.message : (e as Error).message)
    } finally {
      setYamlBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[var(--topbar-h)] items-center justify-between border-b border-line px-5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">
            {isNew ? 'New Persona' : persona!.display_name}
          </span>
          {!isNew && (
            <span className="font-mono text-[11px] text-ink-dim">{persona!.slug}</span>
          )}
        </div>
        <button onClick={onClose} className="btn btn-ghost h-7 w-7 px-0" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* Mode tabs */}
      <div className="border-b border-line px-5 pt-3">
        <div className="flex gap-1 text-xs font-medium">
          <button
            onClick={() => setMode('form')}
            className={cn(
              '-mb-px border-b-2 px-2.5 py-2',
              mode === 'form'
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-dim hover:text-ink',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5" /> Form
            </span>
          </button>
          <button
            onClick={() => setMode('yaml')}
            className={cn(
              '-mb-px border-b-2 px-2.5 py-2',
              mode === 'yaml'
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-dim hover:text-ink',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <Code2 className="h-3.5 w-3.5" /> YAML
            </span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 scroll-thin">
        {mode === 'form' ? (
          <FormFields
            isNew={isNew}
            slug={slug}
            setSlug={setSlug}
            displayName={displayName}
            setDisplayName={setDisplayName}
            description={description}
            setDescription={setDescription}
            domain={domain}
            setDomain={setDomain}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            scopes={scopes}
            allowedScopes={allowedScopes}
            setAllowedScopes={setAllowedScopes}
            cursorJson={cursorJson}
            setCursorJson={setCursorJson}
            capabilitiesJson={capabilitiesJson}
            setCapabilitiesJson={setCapabilitiesJson}
          />
        ) : (
          <YamlPane
            initial={persona}
            yamlText={yamlText}
            setYamlText={setYamlText}
            scopes={scopes}
          />
        )}

        {persona && mode === 'form' && (
          <PreviewPane
            persona={persona}
            preview={preview}
            busy={previewBusy}
            revealed={previewRevealed}
            onReveal={() => loadPreview(true)}
            onMask={() => {
              setPreview(null)
              loadPreview(false)
            }}
          />
        )}
      </div>

      <footer className="border-t border-line p-4">
        {(err || yamlImportErr) && (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-bad/30 bg-bad/5 px-2 py-1.5 text-[11px] text-bad">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="font-mono">{yamlImportErr ?? err}</div>
          </div>
        )}
        {okMsg && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-good/30 bg-good/5 px-2 py-1.5 text-[11px] text-good">
            <Check className="h-3 w-3" /> {okMsg}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          {persona && !isNew ? (
            <button
              onClick={deleteIt}
              disabled={busy}
              className="btn btn-ghost h-8 px-2 text-xs text-bad"
            >
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost h-8 px-3 text-xs">
              取消
            </button>
            {mode === 'form' ? (
              <button onClick={save} disabled={busy} className="btn btn-primary h-8 px-3 text-xs">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {isNew ? '创建' : '保存'}
              </button>
            ) : (
              <button
                onClick={saveFromYaml}
                disabled={yamlBusy || !yamlText.trim()}
                className="btn btn-primary h-8 px-3 text-xs"
              >
                {yamlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                从 YAML 保存
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

function defaultCursorSettings() {
  return {
    runtime: 'cloud',
    model: 'composer-2',
    permission_mode: 'plan',
    setting_sources: ['user'],
    max_budget_usd: 0.5,
    max_turns: 20,
    auto_create_pr: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Form fields panel
// ─────────────────────────────────────────────────────────────────────────────

function FormFields(props: {
  isNew: boolean
  slug: string
  setSlug: (v: string) => void
  displayName: string
  setDisplayName: (v: string) => void
  description: string | null
  setDescription: (v: string) => void
  domain: string | null
  setDomain: (v: string) => void
  systemPrompt: string
  setSystemPrompt: (v: string) => void
  scopes: VaultScope[]
  allowedScopes: string[]
  setAllowedScopes: (v: string[]) => void
  cursorJson: string
  setCursorJson: (v: string) => void
  capabilitiesJson: string
  setCapabilitiesJson: (v: string) => void
}) {
  function toggleScope(id: string) {
    if (props.allowedScopes.includes(id)) {
      props.setAllowedScopes(props.allowedScopes.filter((x) => x !== id))
    } else {
      props.setAllowedScopes([...props.allowedScopes, id])
    }
  }
  return (
    <div className="space-y-4">
      <Field label="slug" hint="lowercase, [a-z0-9_]+">
        <input
          className="input font-mono"
          value={props.slug}
          onChange={(e) => props.setSlug(e.target.value)}
          disabled={!props.isNew}
          placeholder="onion_boss_analyst"
        />
      </Field>
      <Field label="display_name">
        <input
          className="input"
          value={props.displayName}
          onChange={(e) => props.setDisplayName(e.target.value)}
          placeholder="洋葱老板·经营分析师"
        />
      </Field>
      <Field label="description (可选)">
        <input
          className="input"
          value={props.description ?? ''}
          onChange={(e) => props.setDescription(e.target.value)}
        />
      </Field>
      <Field label="domain (可选)" hint="自由 tag, UI 用来分组">
        <input
          className="input font-mono"
          value={props.domain ?? ''}
          onChange={(e) => props.setDomain(e.target.value)}
          placeholder="analytics"
        />
      </Field>
      <Field label="system_prompt" hint="给 AI 的角色指令">
        <textarea
          className="input min-h-[160px] resize-y font-mono text-[12px] leading-relaxed"
          value={props.systemPrompt}
          onChange={(e) => props.setSystemPrompt(e.target.value)}
          placeholder="你是…"
        />
      </Field>
      <Field
        label={`allowed_scopes (${props.allowedScopes.length})`}
        hint="点击切换；scopes 在 /vaults 创建"
      >
        {props.scopes.length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-3 text-xs text-ink-dim">
            还没有 scope。先去 <a className="text-ink underline" href="/vaults">/vaults</a> 创建。
          </div>
        ) : (
          <ul className="space-y-1">
            {props.scopes.map((s) => {
              const on = props.allowedScopes.includes(s.id)
              return (
                <li key={s.id}>
                  <button
                    onClick={() => toggleScope(s.id)}
                    type="button"
                    className={cn(
                      'flex w-full items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px]',
                      on
                        ? 'border-accent/50 bg-accent/5 text-ink'
                        : 'border-line text-ink-muted hover:bg-surface-2',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="font-mono">{s.name}</div>
                      {s.description && (
                        <div className="mt-0.5 text-[11px] text-ink-dim">{s.description}</div>
                      )}
                      <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] text-ink-dim">
                        {(s.bindings as Array<{ env?: string; kind?: string }>).map((b, i) => (
                          <span key={i} className="rounded bg-surface-2 px-1.5">
                            {b.env}:{b.kind}
                          </span>
                        ))}
                      </div>
                    </div>
                    {on && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Field>
      <Field label="cursor_settings (JSON)" hint="permission_mode / model / 工具白名单等">
        <textarea
          className="input min-h-[140px] resize-y font-mono text-[11px] leading-relaxed"
          value={props.cursorJson}
          onChange={(e) => props.setCursorJson(e.target.value)}
        />
      </Field>
      <Field
        label="capabilities (JSON)"
        hint="manifest, dashboard 用来渲染卡片；高级编辑建议切到 YAML 模式"
      >
        <textarea
          className="input min-h-[140px] resize-y font-mono text-[11px] leading-relaxed"
          value={props.capabilitiesJson}
          onChange={(e) => props.setCapabilitiesJson(e.target.value)}
          placeholder="[]"
        />
      </Field>
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
    <label className="block">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-ink-dim">{label}</span>
        {hint && <span className="text-[11px] text-ink-dim">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML pane (paste round-trip)
// ─────────────────────────────────────────────────────────────────────────────

function YamlPane({
  initial,
  yamlText,
  setYamlText,
  scopes,
}: {
  initial?: ServerPersona
  yamlText: string
  setYamlText: (v: string) => void
  scopes: VaultScope[]
}) {
  // Lazy-prefill from the loaded persona on first open of YAML mode.
  useEffect(() => {
    if (yamlText) return
    if (!initial) {
      setYamlText(SAMPLE_PERSONA_YAML)
    } else {
      setYamlText(personaToYaml(initial, scopes))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-line bg-surface-2/40 p-3 text-[11px] text-ink-muted">
        粘贴一份符合{' '}
        <span className="font-mono text-ink">personas/spec/persona.schema.json</span> 的 YAML。
        scope 用 <span className="font-mono text-ink">name</span> 引用（会自动解析成 UUID）。
        <br />
        服务端不解释 capabilities，只透传；规范见{' '}
        <span className="font-mono text-ink">PERSONA_SPEC.md §2</span>。
      </div>
      <textarea
        className="input min-h-[460px] resize-y font-mono text-[11px] leading-relaxed"
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}

const SAMPLE_PERSONA_YAML = `spec_version: "1.0"

slug: my_persona
display_name: 我的 AI
description: …
domain: analytics
allowed_scopes:
  - onion.readonly_business
  - onion.api_base

system_prompt: |
  你是…

cursor_settings:
  runtime: cloud
  model: composer-2
  permission_mode: plan
  max_budget_usd: 0.5

capabilities: []
`

// ─────────────────────────────────────────────────────────────────────────────
// Preview pane (masked / reveal)
// ─────────────────────────────────────────────────────────────────────────────

function PreviewPane({
  persona,
  preview,
  busy,
  revealed,
  onReveal,
  onMask,
}: {
  persona: ServerPersona
  preview: PersonaPreview | null
  busy: boolean
  revealed: boolean
  onReveal: () => void
  onMask: () => void
}) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-2/40">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-ink">
          <span>注入预览</span>
          <span className="font-mono text-[11px] text-ink-dim">/preview-env</span>
        </div>
        <div className="flex items-center gap-1">
          {revealed ? (
            <button onClick={onMask} className="btn btn-ghost h-7 px-2 text-[11px]" disabled={busy}>
              <EyeOff className="h-3 w-3" /> 隐藏
            </button>
          ) : (
            <button
              onClick={onReveal}
              className="btn btn-ghost h-7 px-2 text-[11px]"
              disabled={busy}
              title="会真的 mint 一个 JWT，仅用于核对"
            >
              <Eye className="h-3 w-3" /> 揭示（mints JWT）
            </button>
          )}
        </div>
      </header>
      {busy && !preview ? (
        <div className="px-3 py-6 text-center text-[11px] text-ink-dim">resolving…</div>
      ) : preview ? (
        <div>
          {!preview.ok && (
            <div className="m-2 rounded border border-bad/30 bg-bad/5 px-2 py-1 text-[11px] text-bad">
              {preview.errors.join('; ')}
            </div>
          )}
          <table className="w-full text-[11px]">
            <thead className="border-b border-line text-left font-mono text-ink-dim">
              <tr>
                <th className="px-3 py-1.5 font-normal">env</th>
                <th className="px-3 py-1.5 font-normal">kind</th>
                <th className="px-3 py-1.5 font-normal">value</th>
                <th className="px-3 py-1.5 font-normal text-right">expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {preview.env.map((e) => (
                <EnvRow key={e.env} env={e} now={now} revealed={revealed} />
              ))}
            </tbody>
          </table>
          <div className="border-t border-line px-3 py-1.5 text-right font-mono text-[10px] text-ink-dim">
            total: {preview.total_value_bytes} bytes · cursor model:{' '}
            {String(persona.cursor_settings.model ?? '—')} · permission_mode:{' '}
            {String(persona.cursor_settings.permission_mode ?? '—')}
          </div>
        </div>
      ) : (
        <div className="px-3 py-6 text-center text-[11px] text-ink-dim">no data</div>
      )}
    </section>
  )
}

function EnvRow({
  env,
  now,
  revealed,
}: {
  env: ResolvedEnvVar
  now: number
  revealed: boolean
}) {
  const ttlLeft = env.expires_at ? Math.max(0, env.expires_at - now) : null
  const expiringSoon = ttlLeft !== null && ttlLeft < 300
  return (
    <tr>
      <td className="px-3 py-1.5 font-mono text-ink">{env.env}</td>
      <td className="px-3 py-1.5 font-mono text-ink-dim">{env.kind}</td>
      <td className="px-3 py-1.5 font-mono text-ink-muted">
        {revealed && env.value
          ? maskRevealedValue(env.value)
          : env.value_len
            ? `[${env.value_len} bytes]`
            : env.kind === 'onion_jwt'
              ? `[mint @ launch · ${env.operator_name ?? '?'}]`
              : env.kind === 'passthrough' && env.secret_name
                ? `[${env.secret_name}]`
                : '—'}
        {revealed && env.value && (
          <button
            className="ml-2 align-middle text-ink-dim hover:text-ink"
            onClick={() => navigator.clipboard.writeText(env.value!)}
            title="复制原值"
          >
            <Copy className="inline h-2.5 w-2.5" />
          </button>
        )}
      </td>
      <td
        className={cn(
          'px-3 py-1.5 text-right font-mono',
          expiringSoon ? 'text-warn' : 'text-ink-dim',
        )}
      >
        {ttlLeft !== null ? formatDuration(ttlLeft) : '—'}
      </td>
    </tr>
  )
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h${(m % 60).toString().padStart(2, '0')}m`
  }
  return `${m}m${s.toString().padStart(2, '0')}s`
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: scope name ↔ id, lightweight YAML round-trip
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve an `allowed_scopes` value (string[] of names OR string[] of UUIDs)
 *  to UUIDs against the loaded scope list. */
function resolveScopeIds(value: unknown, scopes: VaultScope[]): string[] {
  if (!Array.isArray(value)) return []
  const byName = new Map(scopes.map((s) => [s.name, s.id]))
  const ids = new Set(scopes.map((s) => s.id))
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    if (ids.has(v)) {
      out.push(v)
      continue
    }
    const id = byName.get(v)
    if (!id) {
      throw new Error(
        `allowed_scopes: scope '${v}' 在当前 backend 不存在；先建好 scope 再 import`,
      )
    }
    out.push(id)
  }
  return out
}

/** Render a persona back as YAML for round-trip editing. We use scope
 *  *names* (not UUIDs) so the output can be checked into the repo. */
function personaToYaml(p: ServerPersona, scopes: VaultScope[]): string {
  const byId = new Map(scopes.map((s) => [s.id, s.name]))
  const scopeNames = p.allowed_scopes.map((id) => byId.get(id) ?? id)
  // Tiny ad-hoc serializer — readable enough for our domain. Avoid
  // pulling in a 30KB YAML library just for this round-trip.
  const lines: string[] = []
  lines.push(`spec_version: "${p.spec_version || '1.0'}"`)
  lines.push('')
  lines.push(`slug: ${p.slug}`)
  lines.push(`display_name: ${quoteIfNeeded(p.display_name)}`)
  if (p.description) lines.push(`description: ${quoteIfNeeded(p.description)}`)
  if (p.domain) lines.push(`domain: ${p.domain}`)
  lines.push('allowed_scopes:')
  scopeNames.forEach((n) => lines.push(`  - ${n}`))
  lines.push('')
  lines.push('system_prompt: |')
  p.system_prompt.split('\n').forEach((line) => lines.push(`  ${line}`))
  lines.push('')
  lines.push(`cursor_settings: ${JSON.stringify(p.cursor_settings, null, 2).split('\n').join('\n')}`)
  lines.push('')
  lines.push(`capabilities: ${JSON.stringify(p.capabilities, null, 2).split('\n').join('\n')}`)
  return lines.join('\n') + '\n'
}

function quoteIfNeeded(s: string): string {
  if (/^[a-zA-Z0-9_./\-:]+$/.test(s)) return s
  // Use double quotes; escape backslashes and double quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Minimal YAML parser for the persona dialect. Handles:
 *    key: value (string/number/bool/null)
 *    key: [a, b]       (inline array)
 *    key: { ... }      (inline object — pass through to JSON.parse)
 *    key:              (block list of `- item`)
 *    key: |            (block string)
 *    key: { JSON-OBJECT-ON-NEXT-LINES via balanced braces }
 *
 *  This is NOT a general-purpose YAML parser; it covers exactly what
 *  PERSONA_SPEC.md emits. Anything weird → JSON parse fallback per-section.
 *  For full-fat YAML, the canonical path is personas/scripts/persona_sync.py. */
function parseSimpleYaml(src: string): unknown {
  const lines = src.split('\n')
  const root: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const stripped = raw.replace(/\s+#.*$/, '')
    if (!stripped.trim() || stripped.trim().startsWith('#')) {
      i++
      continue
    }
    const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2]
    if (rest === '|') {
      // Block string — collect indented lines.
      const buf: string[] = []
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        buf.push(lines[i].slice(2))
        i++
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop()
      root[key] = buf.join('\n') + '\n'
      continue
    }
    if (rest === '') {
      // Either an empty mapping (next line indented) or block list.
      const next = lines[i + 1] ?? ''
      if (next.trimStart().startsWith('- ')) {
        const arr: unknown[] = []
        i++
        while (i < lines.length && lines[i].trimStart().startsWith('- ')) {
          arr.push(coerceScalar(lines[i].trimStart().slice(2).trim()))
          i++
        }
        root[key] = arr
        continue
      } else {
        // Treat as JSON-block: collect until indentation drops.
        const buf: string[] = []
        i++
        while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
          buf.push(lines[i].slice(2))
          i++
        }
        try {
          root[key] = JSON.parse(buf.join('\n'))
        } catch {
          root[key] = buf.join('\n')
        }
        continue
      }
    }
    // Inline value: try JSON first, else scalar.
    try {
      root[key] = JSON.parse(rest)
    } catch {
      root[key] = coerceScalar(rest)
    }
    i++
  }
  return root
}

function coerceScalar(s: string): unknown {
  const t = s.trim()
  if (!t) return ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return t
}
