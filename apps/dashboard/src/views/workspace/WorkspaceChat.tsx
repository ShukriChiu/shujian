import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Database,
  Sparkles,
  StopCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from '@/views/agents/conversation/Markdown'
import type { AssistantBlock, Turn } from '@/views/agents/conversation/turns'
import {
  SEED_PROMPTS,
  type UseMockChatReturn,
} from '@/views/agents/conversation/artifact/useMockChat'
import { ARTIFACTS } from '@/views/agents/conversation/artifact/mock-data'

interface Props {
  chat: UseMockChatReturn
  /** Notify parent so it can transition the artifact pane in. */
  onArtifactRequested?: () => void
}

export function WorkspaceChat({ chat, onArtifactRequested }: Props) {
  const [draft, setDraft] = useState('')

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/40">
      <ChatHeader chat={chat} />
      <ScrollableThread
        turns={chat.turns}
        onPickPrompt={(text) => {
          setDraft(text)
        }}
        onArtifactClick={(id) => chat.selectArtifact(id)}
        followups={
          chat.turns.length > 0 ? deriveFollowups(chat.turns, chat.busy) : []
        }
        onPickFollowup={(text) => {
          setDraft(text)
        }}
      />
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={(text) => {
          chat.send(text)
          onArtifactRequested?.()
          setDraft('')
        }}
        onStop={chat.stop}
        busy={chat.busy}
        emptyHint={chat.turns.length === 0}
      />
    </div>
  )
}

function ChatHeader({ chat }: { chat: UseMockChatReturn }) {
  return (
    <header className="flex items-center justify-between border-b border-line bg-surface/60 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-2 text-[12px]">
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
    </header>
  )
}

/* -------------------------------- thread -------------------------------- */

function ScrollableThread({
  turns,
  onPickPrompt,
  onArtifactClick,
  followups,
  onPickFollowup,
}: {
  turns: Turn[]
  onPickPrompt: (text: string) => void
  onArtifactClick: (id: string) => void
  followups: string[]
  onPickFollowup: (text: string) => void
}) {
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
  }, [turns, pinned, followups.length])

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <EmptyState onPick={onPickPrompt} />
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
                <AssistantTurn t={t} onArtifactClick={onArtifactClick} />
              )}
            </li>
          ))}
        </ol>
        {followups.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 animate-fade-up">
            {followups.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onPickFollowup(f)}
                className="group flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-muted transition-colors duration-150 ease-out-quart hover:border-accent/40 hover:bg-accent-tint hover:text-accent"
              >
                <ArrowUp className="h-3 w-3 -rotate-45" />
                {f}
              </button>
            ))}
          </div>
        )}
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

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="max-w-md text-center">
      <div className="relative mx-auto mb-5 h-12 w-12">
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-accent/15 blur-xl" />
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface">
          <Database className="h-5 w-5 text-accent" />
        </div>
      </div>
      <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
        问点关于业务的事
      </h2>
      <p className="mt-1.5 text-[12.5px] leading-[1.6] text-ink-muted">
        我会从 vaults 取数、做图、给建议。问完一个问题，可以接着追问员工层面、调整建议。
      </p>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {SEED_PROMPTS.map((p) => (
          <button
            key={p.kind}
            type="button"
            onClick={() => onPick(p.label)}
            className="group flex flex-col items-start gap-1 rounded-lg border border-line bg-surface px-3.5 py-3 text-left transition-all duration-200 ease-out-quart hover:-translate-y-px hover:border-accent/40 hover:bg-accent-tint"
          >
            <span className="text-[11px] font-mono uppercase tracking-[0.06em] text-ink-dim group-hover:text-accent">
              {ARTIFACTS[p.kind].kind}
            </span>
            <span className="text-[13px] text-ink">{p.label}</span>
          </button>
        ))}
      </div>
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

function AssistantTurn({
  t,
  onArtifactClick,
}: {
  t: Extract<Turn, { role: 'assistant' }>
  onArtifactClick: (id: string) => void
}) {
  const streaming = t.status === 'streaming'
  return (
    <div className="flex animate-block-in flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-dim">
        <span
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded-md',
            streaming ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-ink-muted',
          )}
        >
          <Sparkles className="h-2.5 w-2.5" />
        </span>
        <span>洋葱业务分析</span>
        {streaming && t.lifecycle && t.lifecycle !== 'RUNNING' && (
          <span className="text-ink-muted">· {t.lifecycle.toLowerCase()}</span>
        )}
        {!streaming && t.durationMs != null && (
          <span className="font-mono">· {(t.durationMs / 1000).toFixed(1)}s</span>
        )}
        {t.status === 'cancelled' && <span className="pill pill-warn ml-auto">cancelled</span>}
      </div>
      {t.blocks.length === 0 && streaming && <ThinkingPulse />}
      {t.blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          last={i === t.blocks.length - 1}
          streaming={streaming}
          onArtifactClick={onArtifactClick}
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
  onArtifactClick,
}: {
  block: AssistantBlock
  last: boolean
  streaming: boolean
  onArtifactClick: (id: string) => void
}) {
  if (block.kind === 'text') {
    return <Markdown text={block.text} streaming={streaming && last} />
  }
  if (block.kind === 'thinking') {
    return <ThinkingBlock text={block.text} />
  }
  return <ToolCallRow block={block} onArtifactClick={onArtifactClick} />
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

const ToolCallRow = memo(function ToolCallRow({
  block,
  onArtifactClick,
}: {
  block: Extract<AssistantBlock, { kind: 'tool_call' }>
  onArtifactClick: (id: string) => void
}) {
  const status = block.status
  const result = block.result as { kind?: string; summary?: string } | undefined
  const artifactId = result?.kind ? `${result.kind}-q3` : null

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[12px]">
      <span
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded',
          status === 'running'
            ? 'bg-accent/15 text-accent'
            : status === 'completed'
              ? 'bg-ok/15 text-ok'
              : 'bg-bad/15 text-bad',
        )}
      >
        <Database className="h-3 w-3" />
      </span>
      <span className="font-mono text-ink">query_business</span>
      <span className="hidden text-ink-muted sm:inline">·</span>
      <span className="hidden truncate text-ink-muted sm:inline">
        {result?.summary ?? '正在查询 vaults…'}
      </span>
      <span
        className={cn(
          'pill ml-auto text-[10px]',
          status === 'running' && 'pill-accent',
          status === 'completed' && 'pill-ok',
          status === 'error' && 'pill-bad',
        )}
      >
        {status}
      </span>
      {artifactId && status === 'completed' && (
        <button
          type="button"
          onClick={() => onArtifactClick(artifactId)}
          className="text-[11px] font-mono uppercase tracking-[0.06em] text-accent transition-colors hover:text-accent-hi"
        >
          ↗ open
        </button>
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
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  onStop: () => void
  busy: boolean
  emptyHint: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(220, el.scrollHeight) + 'px'
  }, [value])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!busy && value.trim()) onSubmit(value)
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!busy && value.trim()) onSubmit(value)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="shrink-0 border-t border-line bg-surface/80 px-4 py-3 backdrop-blur">
      <div className="rounded-lg border border-line bg-surface transition-shadow duration-150 ease-out-quart focus-within:border-accent/60 focus-within:shadow-ring-accent">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          placeholder={
            emptyHint ? '问问 Q3 营收、退款原因、未消课时…' : '继续追问，或换个角度看数据'
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

/* ------------------------------ followups -------------------------------- */

function deriveFollowups(turns: Turn[], busy: boolean): string[] {
  if (busy) return []
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant' || last.status !== 'done') return []
  const tool = last.blocks.find((b) => b.kind === 'tool_call') as
    | Extract<AssistantBlock, { kind: 'tool_call' }>
    | undefined
  const kind = (tool?.result as { kind?: keyof typeof ARTIFACTS } | undefined)?.kind
  if (!kind) return []
  return ARTIFACTS[kind].followups
}
