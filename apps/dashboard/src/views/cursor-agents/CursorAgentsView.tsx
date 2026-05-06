import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cloud, Cpu, Loader2, MessageSquarePlus, Plus, Send, Square, Trash2 } from 'lucide-react'
import { buildCursorStreamUrl, cursorApi, type CursorAgent, type CursorModel } from '@/lib/api'
import { EmptyState, ErrorBanner, Panel } from '@/components/Panel'
import { cn } from '@/lib/utils'
import { Conversation } from './ConversationView'
import { applyEvent, newAssistantTurn, newUserTurn, type Turn } from './turns'
import { SkillPicker, detectSlashContext, filterSkills } from './SkillPicker'

const SDK_EVENT_TYPES = [
  'system',
  'user',
  'assistant',
  'thinking',
  'tool_call',
  'status',
  'task',
  'request',
  'done',
  'error',
] as const

function defaultCwd(): string {
  return '/Users/shujianzhao/Documents/shujian-coding'
}

export function CursorAgentsView() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['cursor', 'me'], queryFn: cursorApi.me, retry: 0 })
  const models = useQuery({ queryKey: ['cursor', 'models'], queryFn: cursorApi.models, retry: 0 })
  const list = useQuery({
    queryKey: ['cursor', 'list'],
    queryFn: cursorApi.list,
    refetchInterval: 5_000,
    retry: 0,
  })

  // — agent creation —
  const [runtime, setRuntime] = useState<'local' | 'cloud'>('local')
  const [model, setModel] = useState<string>('composer-2')
  const [cwd, setCwd] = useState<string>(defaultCwd())
  const [repoUrl, setRepoUrl] = useState<string>('')
  const [autoCreatePR, setAutoCreatePR] = useState(false)
  const [name, setName] = useState<string>('')
  // Setting layers — controls whether the SDK loads .cursor/skills/, .cursor/mcp.json,
  // .cursor/agents/*.md, .cursor/hooks.json from project / user / plugins.
  const [loadProject, setLoadProject] = useState(true)
  const [loadUser, setLoadUser] = useState(true)
  const [loadPlugins, setLoadPlugins] = useState(false)

  // — conversation per agentId, in-memory —
  const [selected, setSelected] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Record<string, Turn[]>>({})
  const [draft, setDraft] = useState<string>('')
  const [streaming, setStreaming] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // — slash-command picker —
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashHighlight, setSlashHighlight] = useState(0)

  // skills are tied to the agent's cwd. We don't know that per-agent, so use
  // the form's cwd as the proxy (matches what was used when the agent was created).
  const skillsQuery = useQuery({
    queryKey: ['cursor', 'skills', cwd],
    queryFn: () => cursorApi.skills(cwd, ['project', 'user']),
    staleTime: 60_000,
    retry: 0,
  })
  const skills = skillsQuery.data?.items ?? []

  const turns = selected ? (conversations[selected] ?? []) : []

  useEffect(() => () => esRef.current?.close(), [])

  // auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns])

  const create = useMutation({
    mutationFn: () => {
      const settingSources: Array<'project' | 'user' | 'plugins'> = []
      if (loadProject) settingSources.push('project')
      if (loadUser) settingSources.push('user')
      if (loadPlugins) settingSources.push('plugins')
      return cursorApi.create({
        runtime,
        model,
        cwd: runtime === 'local' ? cwd : undefined,
        repoUrl: runtime === 'cloud' ? repoUrl : undefined,
        autoCreatePR: runtime === 'cloud' ? autoCreatePR : undefined,
        name: name.trim() || undefined,
        settingSources: runtime === 'local' ? settingSources : undefined,
      })
    },
    onSuccess: (created) => {
      setSelected(created.agentId)
      setConversations((prev) => ({ ...prev, [created.agentId]: prev[created.agentId] ?? [] }))
      qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
    },
  })

  const dispose = useMutation({
    mutationFn: (id: string) => cursorApi.dispose(id),
    onSuccess: (_, id) => {
      if (selected === id) setSelected(null)
      setConversations((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      qc.invalidateQueries({ queryKey: ['cursor', 'list'] })
    },
  })

  function send() {
    if (!selected || !draft.trim() || streaming) return
    const agentId = selected
    const userText = draft
    setDraft('')
    setStreaming(true)

    setConversations((prev) => {
      const existing = prev[agentId] ?? []
      return {
        ...prev,
        [agentId]: [...existing, newUserTurn(userText), newAssistantTurn()],
      }
    })

    cursorApi
      .startStreamingRun(agentId, userText)
      .then((started) => {
        // attach runId to the assistant turn
        setConversations((prev) => {
          const list = prev[agentId] ?? []
          const last = list[list.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return {
            ...prev,
            [agentId]: [...list.slice(0, -1), { ...last, runId: started.runId }],
          }
        })

        const url = buildCursorStreamUrl(started.agentId, started.runId)
        const es = new EventSource(url)
        esRef.current?.close()
        esRef.current = es

        const handler = (type: string) => (event: MessageEvent) => {
          let payload: unknown = event.data
          try {
            payload = JSON.parse(event.data)
          } catch {}
          setConversations((prev) => {
            const list = prev[agentId] ?? []
            return { ...prev, [agentId]: applyEvent(list, type, payload) }
          })
          if (type === 'done' || type === 'error') {
            es.close()
            setStreaming(false)
          }
        }
        SDK_EVENT_TYPES.forEach((t) => es.addEventListener(t, handler(t)))
        es.onerror = () => {
          setConversations((prev) => {
            const list = prev[agentId] ?? []
            return { ...prev, [agentId]: applyEvent(list, 'error', { message: 'SSE 连接中断' }) }
          })
          es.close()
          setStreaming(false)
        }
      })
      .catch((e) => {
        setConversations((prev) => {
          const list = prev[agentId] ?? []
          return { ...prev, [agentId]: applyEvent(list, 'error', { message: String(e) }) }
        })
        setStreaming(false)
      })
  }

  function stop() {
    esRef.current?.close()
    setStreaming(false)
    if (!selected) return
    setConversations((prev) => {
      const list = prev[selected] ?? []
      return { ...prev, [selected]: applyEvent(list, 'done', { status: 'cancelled' }) }
    })
  }

  function clearConversation() {
    if (!selected) return
    setConversations((prev) => ({ ...prev, [selected]: [] }))
  }

  function updateSlashState(text: string, caret: number) {
    const ctx = detectSlashContext(text, caret)
    if (ctx === null) {
      if (slashOpen) setSlashOpen(false)
      return
    }
    if (!slashOpen) setSlashOpen(true)
    if (ctx !== slashQuery) {
      setSlashQuery(ctx)
      setSlashHighlight(0)
    }
  }

  function pickSkill(skillName: string) {
    const ta = textareaRef.current
    if (!ta) return
    const caret = ta.selectionStart ?? draft.length
    // walk back to find the slash position
    let slashIdx = -1
    for (let i = caret - 1; i >= 0; i--) {
      const ch = draft[i]
      if (ch === '/') {
        slashIdx = i
        break
      }
      if (ch === ' ' || ch === '\n' || ch === '\t') break
    }
    if (slashIdx < 0) return
    const before = draft.slice(0, slashIdx)
    const after = draft.slice(caret)
    const insertion = `/${skillName} `
    const next = before + insertion + after
    setDraft(next)
    setSlashOpen(false)
    setSlashQuery('')
    requestAnimationFrame(() => {
      const pos = (before + insertion).length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      const filtered = filterSkills(skills, slashQuery)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashHighlight(Math.min(slashHighlight + 1, Math.max(0, filtered.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashHighlight(Math.max(0, slashHighlight - 1))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filtered.length > 0) {
        e.preventDefault()
        const pick = filtered[Math.min(slashHighlight, filtered.length - 1)]
        if (pick) pickSkill(pick.name)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  if (me.error && (me.error as Error).message.includes('CURSOR_API_KEY missing')) {
    return (
      <Panel title="cursor-bridge 未配置 API Key" sub="先把 .env 准备好">
        <div className="space-y-3 px-5 py-5 text-xs text-ink-600">
          <p>请按以下步骤启动 cursor-bridge：</p>
          <pre className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-[11px]">{`cd shujian-agent/cursor-bridge
cp .env.example .env
# 填入从 https://cursor.com/dashboard/integrations 拿到的 CURSOR_API_KEY
bun install
bun run dev`}</pre>
          <p>启动后重载本页即可。</p>
        </div>
      </Panel>
    )
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div className="space-y-5">
        <Panel
          title="新建 Cursor Agent"
          sub="local 跑本机 / cloud 跑 Cursor 托管 VM"
          bodyClassName="space-y-3 p-4"
        >
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRuntime('local')}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition',
                runtime === 'local'
                  ? 'border-violet-300 bg-violet-50 text-violet-700'
                  : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300',
              )}
            >
              <Cpu className="h-3 w-3" /> local
            </button>
            <button
              type="button"
              onClick={() => setRuntime('cloud')}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition',
                runtime === 'cloud'
                  ? 'border-violet-300 bg-violet-50 text-violet-700'
                  : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300',
              )}
            >
              <Cloud className="h-3 w-3" /> cloud
            </button>
          </div>

          <Field label="Model">
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {(models.data ?? []).map((m: CursorModel) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} — {m.id}
                </option>
              ))}
              {!models.data && <option value="composer-2">composer-2 (默认)</option>}
            </select>
          </Field>

          <Field label="名称（可选）">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：refactor-auth"
            />
          </Field>

          {runtime === 'local' ? (
            <>
              <Field label="工作目录 cwd">
                <input
                  className="input font-mono"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/绝对/路径/到/仓库"
                />
              </Field>
              <Field label="加载 Cursor 设置层">
                <div className="space-y-1">
                  <SettingToggle
                    checked={loadProject}
                    onChange={setLoadProject}
                    label="project"
                    hint=".cursor/skills、.cursor/mcp.json、.cursor/agents/*.md"
                  />
                  <SettingToggle
                    checked={loadUser}
                    onChange={setLoadUser}
                    label="user"
                    hint="~/.cursor/skills-cursor、~/.cursor/mcp.json"
                  />
                  <SettingToggle
                    checked={loadPlugins}
                    onChange={setLoadPlugins}
                    label="plugins"
                    hint="装在 Cursor 里的插件提供的 skills / MCP"
                  />
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field label="Repo URL">
                <input
                  className="input font-mono"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/your-org/your-repo"
                />
              </Field>
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={autoCreatePR}
                  onChange={(e) => setAutoCreatePR(e.target.checked)}
                />
                结束自动开 PR
              </label>
            </>
          )}

          <button
            className="btn btn-primary w-full"
            disabled={
              create.isPending || (runtime === 'local' ? !cwd.trim() : !repoUrl.trim())
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            创建 Agent
          </button>
          {create.error && <ErrorBanner error={create.error} />}
        </Panel>

        <Panel
          title="活跃 Agents"
          sub={list.data ? `${list.data.items.length} 个 in-memory` : '加载中…'}
          actions={
            <button
              className="btn-ghost btn h-7 text-[11px]"
              onClick={() => qc.invalidateQueries({ queryKey: ['cursor', 'list'] })}
            >
              刷新
            </button>
          }
        >
          {list.error ? (
            <ErrorBanner error={list.error} />
          ) : list.data?.items.length ? (
            <div className="divide-y divide-ink-100">
              {list.data.items.map((a: CursorAgent) => {
                const isCloud = a.agentId.startsWith('bc-')
                const active = a.agentId === selected
                const turnCount = (conversations[a.agentId] ?? []).length
                return (
                  <div
                    key={a.agentId}
                    className={cn('px-3 py-2 transition', active && 'bg-violet-50/40')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-800 hover:text-violet-700"
                        onClick={() => setSelected(a.agentId)}
                        title={a.agentId}
                      >
                        {a.agentId}
                      </button>
                      <div className="flex items-center gap-1">
                        <span className={cn('pill', isCloud ? 'pill-accent' : 'pill-info')}>
                          {isCloud ? 'cloud' : 'local'}
                        </span>
                        <button
                          className="btn-ghost btn h-6 px-1.5"
                          onClick={() => dispose.mutate(a.agentId)}
                          title="释放"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-500">
                      {a.model?.id && <span>{a.model.id}</span>}
                      {turnCount > 0 && (
                        <>
                          <span className="text-ink-300">·</span>
                          <span>{turnCount} 轮</span>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <EmptyState title="未创建" hint="左上角填表创建 local 或 cloud agent。" />
          )}
        </Panel>

        {me.data && (
          <div className="panel px-4 py-3 text-[11px] text-ink-500">
            <div className="font-medium text-ink-700">
              {me.data.userEmail ?? me.data.apiKeyName}
            </div>
            <div className="mt-0.5">CURSOR_API_KEY · {me.data.apiKeyName}</div>
          </div>
        )}
      </div>

      {/* Right: Cursor-style chat */}
      <Panel
        title={selected ? `对话 → ${selected.slice(0, 20)}…` : '对话'}
        sub={
          selected
            ? `${turns.length} 轮 · 流式响应聚合 · 工具调用可展开`
            : '左侧选一个或新建一个 agent 开始对话'
        }
        actions={
          <div className="flex items-center gap-2">
            {streaming && (
              <span className="pill pill-warn">
                <Loader2 className="h-3 w-3 animate-spin" /> streaming
              </span>
            )}
            {turns.length > 0 && !streaming && (
              <button
                className="btn btn-ghost h-7 text-[11px]"
                onClick={clearConversation}
                title="清空当前对话"
              >
                <MessageSquarePlus className="h-3 w-3" /> 新对话
              </button>
            )}
          </div>
        }
        bodyClassName="flex flex-col"
      >
        <div
          ref={scrollRef}
          className="min-h-[55vh] flex-1 overflow-y-auto scroll-thin px-4 py-4"
        >
          {selected ? (
            <Conversation turns={turns} />
          ) : (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 text-center text-ink-500">
              <div className="text-sm font-medium text-ink-700">先选一个 agent</div>
              <div className="max-w-[40ch] text-xs">
                左侧「活跃 Agents」点一个 agent ID，或上面填表创建一个新的。
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-ink-200/70 bg-white/80 p-3">
          <div className="relative rounded-xl border border-ink-300 bg-white p-2 shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-200">
            <SkillPicker
              open={slashOpen && !!selected && !streaming}
              query={slashQuery}
              skills={skills}
              highlight={slashHighlight}
              setHighlight={setSlashHighlight}
              onPick={(s) => pickSkill(s.name)}
              onClose={() => setSlashOpen(false)}
            />
            <textarea
              ref={textareaRef}
              className="block w-full resize-none border-0 bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-0"
              rows={2}
              placeholder={
                selected
                  ? '问点什么…  打 / 看 skills · Enter 发送 · Shift+Enter 换行'
                  : '先选一个 agent 才能发送'
              }
              value={draft}
              disabled={!selected || streaming}
              onChange={(e) => {
                setDraft(e.target.value)
                updateSlashState(e.target.value, e.target.selectionStart ?? e.target.value.length)
              }}
              onKeyUp={(e) => {
                const t = e.currentTarget
                updateSlashState(t.value, t.selectionStart ?? t.value.length)
              }}
              onClick={(e) => {
                const t = e.currentTarget
                updateSlashState(t.value, t.selectionStart ?? t.value.length)
              }}
              onKeyDown={onKeyDown}
            />
            <div className="mt-1 flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5 text-[10px] text-ink-500">
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">/</span>
                <span>{skills.length} skills</span>
                <span className="text-ink-300">·</span>
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">Enter</span>
                <span>发送</span>
                <span className="text-ink-300">·</span>
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">Shift+Enter</span>
                <span>换行</span>
              </div>
              {streaming ? (
                <button className="btn h-7 px-2 text-[11px]" onClick={stop} title="取消运行">
                  <Square className="h-3 w-3" /> 停止
                </button>
              ) : (
                <button
                  className="btn btn-primary h-7 px-3 text-[11px]"
                  disabled={!selected || !draft.trim()}
                  onClick={send}
                >
                  <Send className="h-3 w-3" /> 发送
                </button>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </label>
      {children}
    </div>
  )
}

function SettingToggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink-200 bg-white px-2 py-1.5 hover:border-ink-300">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[11px] font-mono font-semibold text-ink-800">{label}</div>
        <div className="mt-0.5 text-[10px] text-ink-500">{hint}</div>
      </div>
    </label>
  )
}
