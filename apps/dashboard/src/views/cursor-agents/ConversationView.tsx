import { useState } from 'react'
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  User,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AssistantBlock, Turn } from './turns'
import { Markdown } from './Markdown'

export function Conversation({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return (
      <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 text-center text-ink-500">
        <Brain className="h-6 w-6 text-ink-300" />
        <div className="text-sm font-medium text-ink-700">还没开始对话</div>
        <div className="max-w-[40ch] text-xs">
          下面输入问题，回车发送。流式响应会在这里展开成 Cursor 风格的对话。
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 px-1 py-1">
      {turns.map((t) => (t.role === 'user' ? <UserTurn key={t.id} t={t} /> : <AssistantTurn key={t.id} t={t} />))}
    </div>
  )
}

function UserTurn({ t }: { t: Extract<Turn, { role: 'user' }> }) {
  // user input is plain text; render as monospace-ish but preserve newlines.
  // We don't run markdown on user messages so that literal `**`, `_` etc. show as typed.
  return (
    <div className="flex items-start justify-end gap-2">
      <div className="max-w-[78%] rounded-2xl rounded-tr-md border border-violet-200 bg-violet-50 px-3.5 py-2 text-sm text-ink-800 shadow-sm whitespace-pre-wrap break-words">
        {renderUserText(t.text)}
      </div>
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-700 text-white">
        <User className="h-3 w-3" />
      </div>
    </div>
  )
}

/** Highlight leading slash command (e.g. `/canvas …`) in user messages. */
function renderUserText(text: string) {
  const m = text.match(/^(\/[A-Za-z0-9_-]+)(\s|$)/)
  if (!m) return text
  return (
    <>
      <span className="rounded bg-violet-200/70 px-1 py-0.5 font-mono text-[12px] font-semibold text-violet-900">
        {m[1]}
      </span>
      {text.slice(m[1].length)}
    </>
  )
}

function AssistantTurn({ t }: { t: Extract<Turn, { role: 'assistant' }> }) {
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white',
          t.status === 'error'
            ? 'bg-red-600'
            : t.status === 'streaming'
              ? 'bg-gradient-to-br from-violet-500 to-indigo-600'
              : 'bg-ink-900',
        )}
      >
        {t.status === 'streaming' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : t.status === 'error' ? (
          <AlertCircle className="h-3 w-3" />
        ) : (
          <CheckCircle2 className="h-3 w-3" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {t.blocks.length === 0 && t.status === 'streaming' && (
          <div className="flex items-center gap-2 text-xs text-ink-500">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-violet-500" />
            等待第一个 token…
          </div>
        )}
        {t.blocks.map((b, i) => {
          const isLastTextWhileStreaming =
            t.status === 'streaming' && b.kind === 'text' && i === t.blocks.length - 1
          return <BlockView key={i} block={b} streaming={isLastTextWhileStreaming} />
        })}
        {(t.status === 'done' || t.status === 'cancelled') && (
          <div className="flex items-center gap-2 pt-1 text-[10px] uppercase tracking-wider text-ink-400">
            <span>{t.status}</span>
            {t.durationMs != null && <span>· {(t.durationMs / 1000).toFixed(2)}s</span>}
            {t.runId && <span className="font-mono">· {t.runId.slice(0, 16)}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function BlockView({ block, streaming }: { block: AssistantBlock; streaming?: boolean }) {
  if (block.kind === 'text') return <Markdown text={block.text} streaming={streaming} />
  if (block.kind === 'thinking') return <ThinkingBlockView text={block.text} duration={block.durationMs} />
  return <ToolCallView block={block} />
}

function ThinkingBlockView({ text, duration }: { text: string; duration?: number }) {
  const [open, setOpen] = useState(false)
  const seconds = duration ? (duration / 1000).toFixed(1) : null
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-ink-600 hover:text-ink-900"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        Thought {seconds ? `for ${seconds}s` : '…'}
      </button>
      {open && (
        <div className="border-t border-ink-200 px-3 py-2 text-[12px] italic leading-relaxed text-ink-600 whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  )
}

const TOOL_ICON: Record<string, typeof Terminal> = {
  shell: Terminal,
  bash: Terminal,
  command: Terminal,
}

function ToolCallView({ block }: { block: Extract<AssistantBlock, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[block.name.toLowerCase()] ?? Wrench
  const statusClass =
    block.status === 'completed'
      ? 'border-emerald-200 bg-emerald-50/60'
      : block.status === 'error'
        ? 'border-red-200 bg-red-50/60'
        : 'border-amber-200 bg-amber-50/60'

  const summary = summarizeArgs(block.name, block.args)

  return (
    <div className={cn('rounded-lg border', statusClass)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        {open ? <ChevronDown className="h-3 w-3 text-ink-500" /> : <ChevronRight className="h-3 w-3 text-ink-500" />}
        <Icon className="h-3.5 w-3.5 text-ink-700" />
        <span className="font-mono text-[11px] font-semibold text-ink-800">{block.name}</span>
        {summary && (
          <span className="truncate text-[11px] text-ink-500" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wider">
          {block.status === 'running' && (
            <span className="flex items-center gap-1 text-amber-700">
              <Loader2 className="h-3 w-3 animate-spin" /> running
            </span>
          )}
          {block.status === 'completed' && (
            <span className="flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> done
            </span>
          )}
          {block.status === 'error' && (
            <span className="flex items-center gap-1 text-red-700">
              <AlertCircle className="h-3 w-3" /> error
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-ink-200/70 px-3 py-2">
          {block.args !== undefined && (
            <CollapsibleJson
              label={block.truncated?.args ? 'args (truncated)' : 'args'}
              data={block.args}
              defaultOpen
            />
          )}
          {block.result !== undefined && (
            <CollapsibleJson
              label={block.truncated?.result ? 'result (truncated)' : 'result'}
              data={block.result}
              defaultOpen={block.status === 'error'}
            />
          )}
          <div className="text-[10px] font-mono text-ink-400">call_id: {block.callId}</div>
        </div>
      )}
    </div>
  )
}

function CollapsibleJson({ label, data, defaultOpen = false }: { label: string; data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const text = formatJson(data)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500 hover:text-ink-800"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-ink-200 bg-white px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ink-700 scroll-thin">
          {text}
        </pre>
      )}
    </div>
  )
}

function summarizeArgs(name: string, args: unknown): string {
  if (args == null || typeof args !== 'object') {
    if (typeof args === 'string') return truncate(args, 80)
    return ''
  }
  const obj = args as Record<string, unknown>
  // a few common heuristics that match Cursor's built-in tools
  for (const key of ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query']) {
    const v = obj[key]
    if (typeof v === 'string') return truncate(v, 80)
  }
  const first = Object.entries(obj)[0]
  if (first) return truncate(`${first[0]}=${JSON.stringify(first[1])}`, 80)
  return ''
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function formatJson(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}
