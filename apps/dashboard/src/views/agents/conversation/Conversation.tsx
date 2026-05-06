import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  ArrowDown,
  ChevronRight,
  CornerDownLeft,
  Loader2,
  Send,
  Sparkles,
  StopCircle,
  Wrench,
  Zap,
} from 'lucide-react'
import {
  buildCursorStreamUrl,
  buildCursorStreamUrlWithAuth,
  cursorApi,
  type CursorMessageResult,
} from '@/lib/api'
import { LOCAL_ENDPOINT } from '@/lib/bridges'
import { cn } from '@/lib/utils'
import {
  applyEvent,
  newAssistantTurn,
  newUserTurn,
  type AssistantBlock,
  type Turn,
} from './turns'
import { Markdown } from './Markdown'

interface ConversationProps {
  agentId: string
  /** Repo URL associated with the agent — only displayed in the empty state. */
  repoLabel?: string
}

/**
 * Multi-turn streaming conversation for a Cursor cloud agent.
 *
 * UX shape:
 *   user    │ right-aligned subtle pill, mono ID feel
 *   assist  │ thinking → tool call op-rows → text (markdown), no bubble
 *   compose │ sticky textarea + ⌘+Enter
 *
 * Streams via EventSource; falls back to the synchronous /messages call when
 * SSE is unavailable.
 */
export function Conversation({ agentId, repoLabel }: ConversationProps) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const startedAtRef = useRef<number>(0)

  /* ------------------------- streaming machinery ------------------------- */

  const stop = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setBusy(false)
  }, [])

  useEffect(() => {
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  const send = useCallback(
    async (message: string) => {
      const text = message.trim()
      if (!text || busy) return

      setStreamError(null)
      setDraft('')
      setBusy(true)
      startedAtRef.current = performance.now()

      // optimistic user + empty assistant turn
      setTurns((prev) => [...prev, newUserTurn(text), newAssistantTurn()])

      try {
        // try streaming first
        const { runId } = await cursorApi.startStreamingRun(agentId, text)
        // patch runId onto the live assistant turn
        setTurns((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, runId }]
        })

        // local bridge: same-origin Vite proxy works without query auth.
        // remote bridge: EventSource cannot set headers, so we sign via ?apiKey=…
        const isLocal = LOCAL_ENDPOINT && cursorEndpointMatches(LOCAL_ENDPOINT)
        const url = isLocal
          ? buildCursorStreamUrl(agentId, runId)
          : buildCursorStreamUrlWithAuth(agentId, runId)

        const es = new EventSource(url)
        esRef.current = es

        const handle = (type: string) => (ev: MessageEvent) => {
          let payload: unknown = ev.data
          try {
            payload = ev.data ? JSON.parse(ev.data) : null
          } catch {
            /* keep raw */
          }
          setTurns((prev) => applyEvent(prev, type, payload))
          if (type === 'done' || type === 'error') {
            const ms = Math.round(performance.now() - startedAtRef.current)
            setTurns((prev) => {
              const last = prev[prev.length - 1]
              if (!last || last.role !== 'assistant') return prev
              return [...prev.slice(0, -1), { ...last, durationMs: ms }]
            })
            es.close()
            esRef.current = null
            setBusy(false)
          }
        }

        const types = [
          'assistant',
          'thinking',
          'tool_call',
          'status',
          'done',
          'error',
          'task',
          'user',
          'system',
          'request',
        ] as const
        for (const t of types) es.addEventListener(t, handle(t))

        es.onerror = () => {
          // EventSource auto-reconnects; we want one-shot semantics, so close.
          if (esRef.current === es) {
            es.close()
            esRef.current = null
            setBusy(false)
            setStreamError('SSE 连接中断，可能是 bridge 离线或不允许跨域')
          }
        }
      } catch (err) {
        // streaming endpoint missing → fall back to sync send
        try {
          const res: CursorMessageResult = await cursorApi.send(agentId, text)
          const ms = Math.round(performance.now() - startedAtRef.current)
          setTurns((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const synthetic: Extract<Turn, { role: 'assistant' }> = {
              ...last,
              status: res.status === 'finished' ? 'done' : (res.status as Turn extends { status: infer S } ? S : never),
              durationMs: res.durationMs ?? ms,
              result: res.result,
              blocks: res.result
                ? [{ kind: 'text', text: res.result }]
                : [{ kind: 'text', text: '(no result)' }],
            }
            return [...prev.slice(0, -1), synthetic]
          })
        } catch (fallbackErr) {
          setStreamError(
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          )
          setTurns((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const synthetic: Extract<Turn, { role: 'assistant' }> = {
              ...last,
              status: 'error',
              blocks: [
                {
                  kind: 'text',
                  text: `[error] ${
                    fallbackErr instanceof Error
                      ? fallbackErr.message
                      : String(fallbackErr)
                  }`,
                },
              ],
            }
            return [...prev.slice(0, -1), synthetic]
          })
        } finally {
          setBusy(false)
        }
        // log the streaming attempt so we can debug
        console.debug('[conversation] streaming start failed, used fallback', err)
      }
    },
    [agentId, busy],
  )

  /* -------------------------------- view -------------------------------- */

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollableThread
        turns={turns}
        repoLabel={repoLabel}
        agentId={agentId}
        onPickPrompt={setDraft}
      />
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        onStop={stop}
        busy={busy}
        error={streamError}
        emptyHint={turns.length === 0}
      />
    </div>
  )
}

function cursorEndpointMatches(prefix: string): boolean {
  // check the active bridge endpoint via the same path constant the api uses
  if (typeof window === 'undefined') return true
  const endpoint = (window as unknown as { __ce?: string }).__ce
  if (typeof endpoint === 'string' && endpoint.startsWith(prefix)) return true
  // best-effort heuristic: if BACKEND_BASE was set to a remote URL the bridge
  // will be set to a remote URL too.
  const stored = localStorage.getItem('shujian.bridges.v1')
  if (!stored) return true
  try {
    const data = JSON.parse(stored)
    return data?.activeEndpoint === prefix || data?.activeEndpoint?.startsWith('/') === true
  } catch {
    return true
  }
}

/* -------------------------- thread + scrolling -------------------------- */

function ScrollableThread({
  turns,
  repoLabel,
  agentId,
  onPickPrompt,
}: {
  turns: Turn[]
  repoLabel?: string
  agentId: string
  onPickPrompt: (text: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)

  // observe scroll to know if the user has scrolled up
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      setPinnedToBottom(dist < 48)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // auto-stick to bottom while pinned
  useLayoutEffect(() => {
    if (!pinnedToBottom) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns, pinnedToBottom])

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <EmptyConversation
          agentId={agentId}
          repoLabel={repoLabel}
          onPickPrompt={onPickPrompt}
        />
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        className="scroll-thin h-full overflow-y-auto px-5 py-5"
        data-conversation-thread
      >
        <ol className="flex flex-col gap-5">
          {turns.map((t) => (
            <li key={t.id}>{t.role === 'user' ? <UserBubble t={t} /> : <AssistantTurn t={t} />}</li>
          ))}
        </ol>
        <div className="h-2" />
      </div>
      {!pinnedToBottom && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
          className={cn(
            'absolute bottom-3 left-1/2 -translate-x-1/2',
            'flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-3 text-[11px] text-ink-muted shadow-[0_8px_20px_-12px_rgba(0,0,0,0.35)]',
            'animate-fade-up hover:bg-surface-3 hover:text-ink',
          )}
        >
          <ArrowDown className="h-3 w-3" />
          jump to latest
        </button>
      )}
    </div>
  )
}

/* --------------------------------- turns -------------------------------- */

function UserBubble({ t }: { t: Extract<Turn, { role: 'user' }> }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-[13.5px] leading-[1.55] text-ink"
        style={{ boxShadow: 'inset 0 0 0 1px oklch(var(--line-l) var(--line-c) var(--line-h))' }}
      >
        {t.text}
      </div>
    </div>
  )
}

function AssistantTurn({ t }: { t: Extract<Turn, { role: 'assistant' }> }) {
  const streaming = t.status === 'streaming'
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-dim">
        <span
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded-md',
            streaming ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-ink-muted',
          )}
        >
          <Sparkles className="h-2.5 w-2.5" />
        </span>
        <span>cursor agent</span>
        {streaming && t.lifecycle && t.lifecycle !== 'RUNNING' && (
          <span className="text-ink-muted">· {t.lifecycle.toLowerCase()}</span>
        )}
        {!streaming && t.durationMs != null && (
          <span className="font-mono">· {(t.durationMs / 1000).toFixed(1)}s</span>
        )}
        {t.status === 'error' && <span className="pill pill-bad ml-auto">error</span>}
        {t.status === 'cancelled' && <span className="pill pill-warn ml-auto">cancelled</span>}
      </div>
      {t.blocks.length === 0 && streaming && <ThinkingPulse />}
      {t.blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          last={i === t.blocks.length - 1}
          streaming={streaming}
        />
      ))}
    </div>
  )
}

function ThinkingPulse() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-dim">
      <span className="flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-ink-dim [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-ink-dim [animation-delay:120ms]" />
        <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-ink-dim [animation-delay:240ms]" />
      </span>
      thinking
    </div>
  )
}

function BlockView({
  block,
  last,
  streaming,
}: {
  block: AssistantBlock
  last: boolean
  streaming: boolean
}) {
  if (block.kind === 'text') {
    return <Markdown text={block.text} streaming={streaming && last} />
  }
  if (block.kind === 'thinking') {
    return <ThinkingBlock text={block.text} durationMs={block.durationMs} />
  }
  return <ToolCallRow block={block} />
}

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  durationMs,
}: {
  text: string
  durationMs?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md bg-surface-2/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-dim hover:text-ink-muted"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 transition-transform duration-150 ease-out-quart',
            open && 'rotate-90',
          )}
        />
        thinking
        {durationMs != null && (
          <span className="ml-1 font-mono normal-case tracking-normal text-ink-dim">
            · {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface px-3 py-2 font-mono text-[11px] leading-[1.6] text-ink-muted scroll-thin">
          {text}
        </pre>
      )}
    </div>
  )
})

const ToolCallRow = memo(function ToolCallRow({
  block,
}: {
  block: Extract<AssistantBlock, { kind: 'tool_call' }>
}) {
  const [open, setOpen] = useState(false)
  const status = block.status

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-2/60 transition-colors duration-200 ease-out-quart">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors duration-150 ease-out-quart',
          'hover:bg-surface-3/50',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-ink-dim transition-transform duration-150 ease-out-quart',
            open && 'rotate-90',
          )}
        />
        <ToolGlyph name={block.name} status={status} />
        <span className="font-mono text-ink truncate">{block.name}</span>
        <ToolStatusDot status={status} className="ml-auto" />
        <span
          className={cn(
            'pill text-[10px]',
            status === 'running' && 'pill-accent',
            status === 'completed' && 'pill-ok',
            status === 'error' && 'pill-bad',
          )}
        >
          {status}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-3">
          {block.args !== undefined && (
            <ToolPayload label="args" value={block.args} truncated={block.truncated?.args} />
          )}
          {block.result !== undefined && (
            <ToolPayload
              label="result"
              value={block.result}
              truncated={block.truncated?.result}
            />
          )}
          {block.args === undefined && block.result === undefined && (
            <div className="text-[11px] text-ink-dim">no payload captured</div>
          )}
        </div>
      )}
    </div>
  )
})

function ToolGlyph({ name, status }: { name: string; status: AssistantBlock['kind'] | string }) {
  const Icon = /^read|file|edit|write/i.test(name)
    ? Wrench
    : /shell|terminal|bash/i.test(name)
      ? Zap
      : Wrench
  return (
    <span
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded',
        status === 'running'
          ? 'bg-accent/15 text-accent'
          : status === 'completed'
            ? 'bg-ok/15 text-ok'
            : status === 'error'
              ? 'bg-bad/15 text-bad'
              : 'bg-surface-3 text-ink-muted',
      )}
    >
      <Icon className="h-3 w-3" />
    </span>
  )
}

function ToolStatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'dot shrink-0',
        status === 'running' && 'dot-running',
        status === 'completed' && 'dot-ok',
        status === 'error' && 'dot-bad',
        className,
      )}
    />
  )
}

function ToolPayload({
  label,
  value,
  truncated,
}: {
  label: string
  value: unknown
  truncated?: boolean
}) {
  const text = useMemo(() => {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [value])
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-dim">
        <span>{label}</span>
        {truncated && <span className="text-warn">truncated</span>}
      </div>
      <pre className="scroll-thin max-h-60 overflow-auto rounded bg-surface px-3 py-2 font-mono text-[11px] leading-[1.55] text-ink-muted">
        {text}
      </pre>
    </div>
  )
}

/* ------------------------------- composer ------------------------------- */

function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  error,
  emptyHint,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  onStop: () => void
  busy: boolean
  error: string | null
  emptyHint: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  // auto-resize textarea
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(220, el.scrollHeight) + 'px'
  }, [value])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!busy) onSubmit(value)
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!busy) onSubmit(value)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="shrink-0 border-t border-line bg-surface/80 px-4 py-3 backdrop-blur"
    >
      {error && (
        <div
          role="alert"
          className="mb-2 rounded-md px-3 py-2 text-[12px]"
          style={{
            border: '1px solid oklch(var(--bad-l) var(--bad-c) var(--bad-h) / 0.32)',
            background: 'var(--bad-tint)',
            color: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h))',
          }}
        >
          {error}
        </div>
      )}
      <div className="rounded-lg border border-line bg-surface transition-shadow duration-150 ease-out-quart focus-within:border-accent/60 focus-within:shadow-ring-accent">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          placeholder={
            emptyHint ? '让它修个 bug、写个 PR、跑个测试…' : '继续追问，或贴一段日志让它分析'
          }
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[13.5px] leading-[1.55] text-ink placeholder:text-ink-dim focus:outline-none"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-2 px-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-ink-dim">
            <span className="kbd">⌘</span>
            <span className="kbd">↵</span>
            <span>send</span>
          </div>
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              className="btn h-8 px-3 text-[12px]"
              aria-label="Stop generation"
            >
              <StopCircle className="h-3.5 w-3.5" />
              stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim()}
              className="btn btn-primary h-8 px-3 text-[12px]"
            >
              {value.trim() ? <Send className="h-3.5 w-3.5" /> : <CornerDownLeft className="h-3.5 w-3.5" />}
              send
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

/* ------------------------------ empty state ----------------------------- */

const QUICK_PROMPTS = [
  { label: '写个测试', text: '给最近改动的代码补一组单元测试，覆盖边界情况。' },
  { label: '解释一下', text: '帮我解释一下这个仓库的核心模块、入口和数据流。' },
  { label: '修个 bug', text: '看看 CI 里最近一次失败，定位原因并提交修复 PR。' },
]

function EmptyConversation({
  agentId,
  repoLabel,
  onPickPrompt,
}: {
  agentId: string
  repoLabel?: string
  onPickPrompt: (text: string) => void
}) {
  return (
    <div className="flex w-full max-w-[440px] flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface-2">
        <Sparkles className="h-5 w-5 text-accent" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink">把活儿交给它</h3>
      <p className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-muted">
        {repoLabel ? (
          <>
            它会在 <span className="font-mono text-ink">{repoLabel}</span> 上工作，
            完成后回一个 PR 链接 + 完整 diff。
          </>
        ) : (
          <>它会在你绑定的仓库里工作，完成后回一个 PR 链接 + 完整 diff。</>
        )}
      </p>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-dim">
        {agentId.slice(0, 28)}
      </div>
      <div className="mt-5 flex w-full flex-wrap justify-center gap-1.5">
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              onPickPrompt(p.text)
              requestAnimationFrame(() => {
                const ta = document.querySelector<HTMLTextAreaElement>('form textarea')
                ta?.focus()
              })
            }}
            className="rounded-full border border-line bg-surface-2 px-3 py-1 text-[11px] text-ink-muted transition-colors duration-150 ease-out-quart hover:border-line-strong hover:bg-surface-3 hover:text-ink"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
