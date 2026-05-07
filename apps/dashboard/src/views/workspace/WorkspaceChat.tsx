import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  Database,
  HelpCircle,
  ListChecks,
  Loader2,
  Sparkles,
  StopCircle,
  Workflow,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from '@/views/agents/conversation/Markdown'
import { hideCanvasInText } from '@/views/agents/conversation/artifact/canvasProtocol'
import type { AssistantBlock, Turn } from '@/views/agents/conversation/turns'
import type { WorkspaceChatHook } from '@/lib/useCursorChat'
import {
  detectSlashTrigger,
  filterSlashCommands,
  type SlashCommand,
} from './slashCommands'

interface Props {
  chat: WorkspaceChatHook
  /** Notify parent so it can transition the artifact pane in. */
  onArtifactRequested?: () => void
}

export function WorkspaceChat({ chat, onArtifactRequested }: Props) {
  const [draft, setDraft] = useState('')

  const submit = (text: string) => {
    if (!text.trim() || chat.busy) return
    chat.send(text)
    onArtifactRequested?.()
    setDraft('')
  }

  // The last user question doubles as a topic anchor at the top of the
  // thread once the conversation grows past the viewport. Cheaper than
  // tracking scroll position for an autohide.
  const lastQuestion = useMemo(() => {
    for (let i = chat.turns.length - 1; i >= 0; i--) {
      const t = chat.turns[i]
      if (t?.role === 'user') return t.text
    }
    return null
  }, [chat.turns])

  // Detect "agent is asking us a question" — last assistant turn is done,
  // its tail text ends with a question mark, and there's no still-running
  // tool call. Lets the composer auto-focus + show a hint.
  const pendingQuestion = useMemo(() => detectAgentQuestion(chat.turns), [chat.turns])

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/40">
      <ChatHeader chat={chat} lastQuestion={lastQuestion} />
      <ScrollableThread turns={chat.turns} />
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        onStop={chat.stop}
        busy={chat.busy}
        emptyHint={chat.turns.length === 0}
        pendingQuestion={pendingQuestion}
      />
    </div>
  )
}

function ChatHeader({
  chat,
  lastQuestion,
}: {
  chat: WorkspaceChatHook
  lastQuestion: string | null
}) {
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface/60 px-4 pb-2.5 pt-2.5 backdrop-blur">
      <div className="flex items-center justify-between text-[12px]">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/15 text-accent">
            <Sparkles className="h-3 w-3" />
          </span>
          <span className="font-semibold tracking-[-0.005em] text-ink">业务分析</span>
          <span className="pill pill-muted text-[10px] font-mono normal-case">vaults · live</span>
        </div>
        {chat.turns.length > 0 && (
          <button
            type="button"
            onClick={chat.reset}
            className="text-[11px] font-mono uppercase tracking-[0.06em] text-ink-dim transition-colors hover:text-ink-muted"
          >
            new thread
          </button>
        )}
      </div>
      {lastQuestion && (
        <div className="flex items-center gap-1.5 text-[11.5px]" title={lastQuestion}>
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
            topic
          </span>
          <span className="truncate text-ink-muted">{lastQuestion}</span>
        </div>
      )}
    </header>
  )
}

/* -------------------------------- thread -------------------------------- */

function ScrollableThread({ turns }: { turns: Turn[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 64)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    if (!pinned) return
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns, pinned])

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} className="scroll-thin h-full overflow-y-auto px-5 py-5">
        <ol className="flex flex-col gap-5">
          {turns.map((t) => (
            <li key={t.id}>
              {t.role === 'user' ? (
                <UserBubble t={t} />
              ) : (
                <AssistantTurn t={t} />
              )}
            </li>
          ))}
        </ol>
        <div className="h-2" />
      </div>
      {!pinned && (
        <button
          type="button"
          onClick={() => {
            const el = ref.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
          className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-3 text-[11px] text-ink-muted shadow-[0_8px_20px_-12px_rgba(0,0,0,0.35)] animate-fade-up hover:bg-surface-3 hover:text-ink"
        >
          <ArrowDown className="h-3 w-3" />
          jump to latest
        </button>
      )}
    </div>
  )
}

/* ------------------------------- empty state ----------------------------- */

function EmptyState() {
  return (
    <div className="max-w-md text-center">
      <div className="relative mx-auto mb-5 h-12 w-12">
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-accent/15 blur-xl" />
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface">
          <Database className="h-5 w-5 text-accent" />
        </div>
      </div>
      <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
        问点什么
      </h2>
      <p className="mt-1.5 text-[12.5px] leading-[1.6] text-ink-muted">
        通过 cursor agent 取数、做图、给建议。让它用 <span className="kbd">```canvas</span> 把
        KPI / 图表 / 表格输出到右侧画布。
      </p>
      <p className="mt-2 text-[11px] text-ink-dim">
        输入 <span className="kbd">/</span> 调用 skills · <span className="kbd">⌘↵</span> 发送
      </p>
    </div>
  )
}

/* --------------------------------- turns --------------------------------- */

function UserBubble({ t }: { t: Extract<Turn, { role: 'user' }> }) {
  return (
    <div className="flex justify-end animate-block-in">
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
    <div className="flex animate-block-in flex-col gap-2">
      {(streaming || t.status === 'cancelled' || t.durationMs != null) && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-dim">
          {streaming ? (
            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          ) : (
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-ok/60" />
          )}
          <span>{streaming ? 'streaming' : 'reply'}</span>
          {!streaming && t.durationMs != null && (
            <span className="text-ink-dim">· {(t.durationMs / 1000).toFixed(1)}s</span>
          )}
          {t.status === 'cancelled' && <span className="pill pill-warn ml-auto">cancelled</span>}
        </div>
      )}
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
    // ```canvas blocks are routed to the right pane via the canvas
    // protocol — strip them out of the chat surface so the prose
    // stays narrative-only. `hideCanvasInText` handles in-progress
    // (unclosed) blocks too, so streaming doesn't briefly leak JSON.
    const visible = hideCanvasInText(block.text)
    if (!visible) return null
    return <Markdown text={visible} streaming={streaming && last} />
  }
  if (block.kind === 'thinking') {
    return <ThinkingBlock text={block.text} />
  }
  // tool_call dispatch — special-case the structured kinds Cursor SDK
  // emits, fall back to a generic foldable row for everything else.
  if (block.name === 'updateTodos') return <TodoListCallRow block={block} />
  if (block.name === 'task') return <SubagentCallRow block={block} />
  return <ToolCallRow block={block} />
}

const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md bg-surface-2/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-dim hover:text-ink-muted"
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform duration-150 ease-out-quart', open && 'rotate-90')}
        />
        thinking
      </button>
      {open && (
        <pre className="scroll-thin mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface px-3 py-2 font-mono text-[11px] leading-[1.6] text-ink-muted">
          {text}
        </pre>
      )}
    </div>
  )
})

/* ------------------------------- tool calls ------------------------------ */

type ToolCallBlock = Extract<AssistantBlock, { kind: 'tool_call' }>

const ToolCallRow = memo(function ToolCallRow({
  block,
}: {
  block: ToolCallBlock
}) {
  const status = block.status
  // Default open while the call is in-flight so the user can see what
  // the agent is doing live; auto-collapse once it completes — mirrors
  // Cursor's IDE behaviour.
  const [open, setOpen] = useState<boolean>(status === 'running' || status === 'error')
  // Keep `open` in sync if status flips after the user has manually
  // toggled — but only one direction (running → completed should
  // collapse; user-opened state stays).
  const wasRunning = useRef(status === 'running')
  useEffect(() => {
    if (wasRunning.current && status !== 'running') {
      setOpen(status === 'error')
    }
    wasRunning.current = status === 'running'
  }, [status])

  const result = block.result as { summary?: string } | undefined
  const summary =
    result?.summary ??
    (status === 'completed'
      ? summarizeToolResult(block.result)
      : status === 'error'
        ? summarizeToolResult(block.result) || 'failed'
        : 'running…')

  return (
    <div className="rounded-md border border-line bg-surface-2/60 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-3/50"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-ink-dim transition-transform duration-150 ease-out-quart',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded',
            status === 'running' && 'bg-accent/15 text-accent',
            status === 'completed' && 'bg-ok/15 text-ok',
            status === 'error' && 'bg-bad/15 text-bad',
          )}
        >
          {status === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : status === 'error' ? (
            <XCircle className="h-3 w-3" />
          ) : (
            <Database className="h-3 w-3" />
          )}
        </span>
        <span className="font-mono text-ink">{block.name || 'tool'}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">
          {summary}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line/60 px-3 py-2 pl-9">
          {block.args !== undefined && (
            <ToolJsonBlock label="input" value={block.args} truncated={block.truncated?.args} />
          )}
          {block.result !== undefined && (
            <ToolJsonBlock label="result" value={block.result} truncated={block.truncated?.result} />
          )}
          {block.args === undefined && block.result === undefined && (
            <span className="text-[11px] text-ink-dim">no payload</span>
          )}
        </div>
      )}
    </div>
  )
})

function ToolJsonBlock({
  label,
  value,
  truncated,
}: {
  label: string
  value: unknown
  truncated?: boolean
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
        <span>{label}</span>
        {truncated && <span className="pill pill-warn text-[9px]">truncated</span>}
      </div>
      <pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-ink-muted">
        {safeStringify(value)}
      </pre>
    </div>
  )
}

/* -------------- specialised: updateTodos (Cursor's todo tool) ------------ */

interface TodoItem {
  content: string
  status: 'pending' | 'inProgress' | 'completed' | 'cancelled'
}

const TodoListCallRow = memo(function TodoListCallRow({ block }: { block: ToolCallBlock }) {
  // The cursor SDK's `updateTodos` carries the live list in `args.todos`
  // and a redundant copy in `result.value.todos`. Prefer args because it
  // updates in real time as the agent revises the plan.
  const todos = pickTodos(block.args) ?? pickTodos((block.result as { value?: unknown })?.value)
  const [open, setOpen] = useState(true)

  if (!todos || todos.length === 0) {
    return <ToolCallRow block={block} />
  }

  const stats = todos.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1
      return acc
    },
    {} as Record<TodoItem['status'], number>,
  )
  const inProgress = todos.find((t) => t.status === 'inProgress')

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 text-ink-dim transition-transform duration-150 ease-out-quart',
            open && 'rotate-90',
          )}
        />
        <ListChecks className="h-3.5 w-3.5 text-accent" />
        <span className="font-medium text-ink">Todo list</span>
        <span className="font-mono text-[11px] text-ink-muted">
          {stats.completed ?? 0}/{todos.length} done
          {(stats.inProgress ?? 0) > 0 && ` · ${stats.inProgress} in progress`}
        </span>
        {inProgress && !open && (
          <span className="ml-auto truncate text-[11px] text-ink-dim">→ {inProgress.content}</span>
        )}
      </button>
      {open && (
        <ul className="space-y-1 border-t border-line/60 px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <TodoIcon status={t.status} />
              <span
                className={cn(
                  'leading-[1.55]',
                  t.status === 'completed' && 'text-ink-dim line-through',
                  t.status === 'cancelled' && 'text-ink-dim opacity-70',
                  t.status === 'inProgress' && 'text-ink',
                  t.status === 'pending' && 'text-ink-muted',
                )}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

function TodoIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
  if (status === 'inProgress') return <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
  if (status === 'cancelled') return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-dim" />
  return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-dim" />
}

function pickTodos(value: unknown): TodoItem[] | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { todos?: unknown }
  if (!Array.isArray(v.todos)) return null
  const out: TodoItem[] = []
  for (const raw of v.todos) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { content?: unknown; status?: unknown }
    if (typeof r.content !== 'string') continue
    const s = r.status
    const status: TodoItem['status'] =
      s === 'pending' || s === 'inProgress' || s === 'completed' || s === 'cancelled'
        ? s
        : 'pending'
    out.push({ content: r.content, status })
  }
  return out
}

/* ------------------- specialised: task (subagent spawn) ------------------ */

const SubagentCallRow = memo(function SubagentCallRow({ block }: { block: ToolCallBlock }) {
  const args = (block.args as
    | {
        description?: string
        prompt?: string
        subagentType?: { kind?: string; name?: string }
        model?: string
      }
    | undefined) ?? {}
  const result = (block.result as
    | { value?: { isBackground?: boolean; durationMs?: number; resultSuffix?: string } }
    | undefined)?.value
  const [open, setOpen] = useState(block.status === 'running')

  const subType = args.subagentType?.name || args.subagentType?.kind || 'subagent'
  const description = args.description || args.prompt?.slice(0, 80) || 'spawned subagent'

  return (
    <div className="rounded-md border border-line bg-surface-2/60 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-3/50"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 text-ink-dim transition-transform duration-150 ease-out-quart',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded',
            block.status === 'running' && 'bg-accent/15 text-accent',
            block.status === 'completed' && 'bg-ok/15 text-ok',
            block.status === 'error' && 'bg-bad/15 text-bad',
          )}
        >
          {block.status === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Workflow className="h-3 w-3" />
          )}
        </span>
        <span className="font-medium text-ink">subagent</span>
        <span className="pill pill-muted text-[10px] font-mono normal-case">{subType}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">{description}</span>
        {result?.durationMs != null && (
          <span className="font-mono text-[10px] text-ink-dim">
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line/60 px-3 py-2 pl-9">
          {args.prompt && (
            <ToolJsonBlock label="prompt" value={args.prompt} />
          )}
          {result?.resultSuffix && (
            <ToolJsonBlock label="suffix" value={result.resultSuffix} />
          )}
          {block.result !== undefined && !result?.resultSuffix && (
            <ToolJsonBlock label="result" value={block.result} truncated={block.truncated?.result} />
          )}
        </div>
      )}
    </div>
  )
})

/* ------------------------------- composer -------------------------------- */

function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  emptyHint,
  pendingQuestion,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  onStop: () => void
  busy: boolean
  emptyHint: boolean
  pendingQuestion: string | null
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [palette, setPalette] = useState<{ items: SlashCommand[]; cursor: number } | null>(null)
  const [trigger, setTrigger] = useState<{ start: number; end: number; query: string } | null>(null)

  // Auto-grow textarea.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(220, el.scrollHeight) + 'px'
  }, [value])

  // Auto-focus when the agent finishes a turn that ends in a question.
  // Don't steal focus on every render — only on the rising edge.
  const lastQuestionRef = useRef<string | null>(null)
  useEffect(() => {
    if (pendingQuestion && pendingQuestion !== lastQuestionRef.current) {
      taRef.current?.focus()
    }
    lastQuestionRef.current = pendingQuestion
  }, [pendingQuestion])

  function refreshPalette(nextValue: string, caret: number) {
    const t = detectSlashTrigger(nextValue, caret)
    if (!t) {
      setPalette(null)
      setTrigger(null)
      return
    }
    const items = filterSlashCommands(t.query)
    if (items.length === 0) {
      setPalette(null)
      setTrigger(t)
      return
    }
    setTrigger(t)
    setPalette({ items, cursor: 0 })
  }

  function applyCommand(cmd: SlashCommand) {
    const t = trigger
    if (!t) return
    const before = value.slice(0, t.start)
    const after = value.slice(t.end)
    const tpl = cmd.template
    const cursorMarker = '{cursor}'
    const cursorIdx = tpl.indexOf(cursorMarker)
    const expanded = cursorIdx >= 0 ? tpl.replace(cursorMarker, '') : tpl
    const next = `${before}${expanded}${after}`
    onChange(next)
    setPalette(null)
    setTrigger(null)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      const pos =
        before.length + (cursorIdx >= 0 ? cursorIdx : expanded.length)
      el.selectionStart = pos
      el.selectionEnd = pos
      el.focus()
    })
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!busy && value.trim()) onSubmit(value)
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Palette navigation overrides cmd-enter / arrow keys.
    if (palette) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPalette({ ...palette, cursor: (palette.cursor + 1) % palette.items.length })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPalette({
          ...palette,
          cursor: (palette.cursor - 1 + palette.items.length) % palette.items.length,
        })
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault()
        const cmd = palette.items[palette.cursor]
        if (cmd) applyCommand(cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPalette(null)
        setTrigger(null)
        return
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!busy && value.trim()) onSubmit(value)
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    onChange(next)
    refreshPalette(next, e.target.selectionStart ?? next.length)
  }

  function handleSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    refreshPalette(el.value, el.selectionStart ?? el.value.length)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="relative shrink-0 border-t border-line bg-surface/80 px-4 py-3 backdrop-blur"
    >
      {pendingQuestion && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-warn/30 bg-warn-tint px-3 py-1.5 text-[11.5px] text-warn animate-fade-up">
          <HelpCircle className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate">agent 在等你回答：{pendingQuestion}</span>
        </div>
      )}
      {palette && trigger && (
        <SlashPalette
          items={palette.items}
          cursor={palette.cursor}
          onPick={applyCommand}
          onHoverIndex={(i) => setPalette({ ...palette, cursor: i })}
        />
      )}
      <div className="rounded-lg border border-line bg-surface transition-shadow duration-150 ease-out-quart focus-within:border-accent/60 focus-within:shadow-ring-accent">
        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyDown={handleKey}
          rows={1}
          placeholder={
            emptyHint
              ? '问问 Q3 营收、退款原因、未消课时…  按 / 调用 skills'
              : '继续追问，或换个角度看数据 · 按 / 调用 skills'
          }
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[13.5px] leading-[1.55] text-ink placeholder:text-ink-dim focus:outline-none"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-2 px-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-ink-dim">
            <span className="kbd">⌘</span>
            <span className="kbd">↵</span>
            <span>send</span>
            <span className="ml-2">·</span>
            <span className="kbd">/</span>
            <span>skills</span>
          </div>
          {busy ? (
            <button type="button" onClick={onStop} className="btn h-8 px-3 text-[12px]" aria-label="Stop">
              <StopCircle className="h-3.5 w-3.5" />
              stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim()}
              className="btn-accent h-8 px-3 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowUp className="h-3.5 w-3.5" />
              send
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

function SlashPalette({
  items,
  cursor,
  onPick,
  onHoverIndex,
}: {
  items: SlashCommand[]
  cursor: number
  onPick: (cmd: SlashCommand) => void
  onHoverIndex: (i: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // Keep the active row in view as the user arrows through.
  useEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLButtonElement>(`[data-i="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <div
      ref={wrapRef}
      className="absolute bottom-full left-4 right-4 mb-2 max-h-72 overflow-auto scroll-thin rounded-lg border border-line-strong bg-surface shadow-lg animate-fade-up"
    >
      <div className="border-b border-line bg-surface-2/60 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-ink-dim">
        skills · {items.length}
      </div>
      <ul>
        {items.map((cmd, i) => (
          <li key={cmd.slug}>
            <button
              type="button"
              data-i={i}
              onMouseEnter={() => onHoverIndex(i)}
              onClick={() => onPick(cmd)}
              className={cn(
                'flex w-full items-start gap-3 px-3 py-2 text-left',
                i === cursor ? 'bg-[var(--accent-tint)]' : 'hover:bg-surface-2',
              )}
            >
              <span className="mt-0.5 w-5 text-center text-[14px] leading-none">
                {cmd.glyph ?? '·'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[12.5px] text-accent">/{cmd.slug}</span>
                  <span className="text-[12px] text-ink">{cmd.label}</span>
                </span>
                <span className="block truncate text-[11.5px] text-ink-dim">{cmd.hint}</span>
              </span>
              {i === cursor && (
                <span className="font-mono text-[10px] text-ink-dim">↵</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------ helpers --------------------------------- */

function detectAgentQuestion(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (!t) continue
    if (t.role !== 'assistant') return null
    if (t.status === 'streaming' || t.status === 'cancelled') return null
    // Skip if a tool call is still resolving.
    if (t.blocks.some((b) => b.kind === 'tool_call' && b.status === 'running')) return null
    // Pull the last meaningful text block.
    let text: string | null = null
    for (let j = t.blocks.length - 1; j >= 0; j--) {
      const b = t.blocks[j]
      if (b?.kind === 'text' && b.text.trim()) {
        text = b.text.trim()
        break
      }
    }
    if (!text) return null
    // Take the last sentence/line for the prompt — questions usually
    // live at the end ("Should I proceed?").
    const lastLine = text.split(/\n+/).filter((l) => l.trim()).pop() ?? text
    const tail = lastLine.trim().slice(-2)
    if (tail.endsWith('?') || tail.endsWith('？')) {
      // Strip the leading bullet/heading marker if present.
      return lastLine.replace(/^[#>*\-\s]+/, '').slice(0, 160)
    }
    return null
  }
  return null
}

function summarizeToolResult(value: unknown): string {
  if (value === null || value === undefined) return '(empty)'
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length === 0) return '{}'
    return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }`
  }
  return String(value)
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const s = JSON.stringify(value, null, 2)
    return s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s
  } catch {
    return String(value)
  }
}
