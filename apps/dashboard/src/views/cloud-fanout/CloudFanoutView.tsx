import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Cloud,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { buildCursorStreamUrl, cursorApi, type CursorAgent } from '@/lib/api'
import { useActiveBridge } from '@/lib/useBridges'
import { Panel } from '@/components/Panel'
import { cn } from '@/lib/utils'

/**
 * Cloud Fan-out
 * -------------
 * Spawn N cloud Cursor agents on the SAME repo, each with its own prompt,
 * each running concurrently in its own sandbox VM. Live status grid.
 *
 * Use cases:
 *  - "let 5 agents triage 5 different bug categories on the same monorepo"
 *  - "ask the same question 3x and pick the best answer"
 *  - "stress-test our quota / parallelism"
 */

const DEFAULT_PROMPTS = [
  '列一下仓库 top-level 目录结构，每个目录一句话说明它干什么。不要修改文件。',
  '搜索仓库里所有 TODO/FIXME 注释，挑 3 个有意思的告诉我（带文件路径）。不要修改文件。',
  '读 README.md，用 3 句话告诉我这个项目是什么、怎么用、目标用户是谁。不要修改文件。',
  '看依赖文件（package.json/Cargo.toml/pyproject.toml），列 5 个最关键的依赖及其作用。不要修改文件。',
  '检查测试现状：有没有测试、怎么跑、覆盖了哪些模块。不要修改文件。',
]

type SlotStatus = 'idle' | 'creating' | 'sending' | 'streaming' | 'done' | 'error'

interface Slot {
  key: string
  prompt: string
  status: SlotStatus
  agentId?: string
  runId?: string
  startedAt?: number
  firstTokenAt?: number
  doneAt?: number
  textChunks: number
  toolCalls: number
  events: number
  lastText: string
  err?: string
  log: string[] // status ticks
}

function newSlot(prompt: string): Slot {
  return {
    key: Math.random().toString(36).slice(2, 9),
    prompt,
    status: 'idle',
    textChunks: 0,
    toolCalls: 0,
    events: 0,
    lastText: '',
    log: [],
  }
}

export function CloudFanoutView() {
  const active = useActiveBridge()
  const [repoUrl, setRepoUrl] = useState<string>('https://github.com/ShukriChiu/onion-agent.git')
  const [startingRef, setStartingRef] = useState<string>('main')
  const [model, setModel] = useState<string>('composer-2')
  const [autoCreatePR, setAutoCreatePR] = useState(false)
  const [slots, setSlots] = useState<Slot[]>(() => DEFAULT_PROMPTS.slice(0, 3).map(newSlot))
  const [running, setRunning] = useState(false)
  const wallStartRef = useRef<number | null>(null)
  const [wallMs, setWallMs] = useState<number | null>(null)
  const esRefs = useRef<Map<string, EventSource>>(new Map())

  useEffect(() => {
    return () => {
      for (const es of esRefs.current.values()) es.close()
      esRefs.current.clear()
    }
  }, [])

  function patch(key: string, p: Partial<Slot>) {
    setSlots((cur) => cur.map((s) => (s.key === key ? { ...s, ...p } : s)))
  }

  function pushLog(key: string, line: string) {
    setSlots((cur) =>
      cur.map((s) =>
        s.key === key ? { ...s, log: [...s.log.slice(-9), `${stamp()} ${line}`] } : s,
      ),
    )
  }

  function addSlot() {
    setSlots((cur) => [...cur, newSlot(DEFAULT_PROMPTS[cur.length % DEFAULT_PROMPTS.length] ?? '')])
  }

  function removeSlot(key: string) {
    setSlots((cur) => (cur.length > 1 ? cur.filter((s) => s.key !== key) : cur))
    const es = esRefs.current.get(key)
    if (es) {
      es.close()
      esRefs.current.delete(key)
    }
  }

  function reset() {
    for (const es of esRefs.current.values()) es.close()
    esRefs.current.clear()
    setSlots((cur) =>
      cur.map((s) => ({
        ...newSlot(s.prompt),
        key: s.key,
      })),
    )
    setWallMs(null)
    wallStartRef.current = null
    setRunning(false)
  }

  async function runSlot(slot: Slot, t0: number): Promise<void> {
    const key = slot.key
    try {
      patch(key, { status: 'creating', startedAt: Date.now() })
      pushLog(key, 'creating cloud agent…')
      const agent: CursorAgent & { runtime: string } = await cursorApi.create({
        runtime: 'cloud',
        model,
        repoUrl,
        startingRef,
        autoCreatePR,
        name: `fanout-${key}`,
      })
      patch(key, { agentId: agent.agentId, status: 'sending' })
      pushLog(key, `agent ${agent.agentId.slice(0, 14)}…`)

      const run = await cursorApi.startStreamingRun(agent.agentId, slot.prompt)
      patch(key, { runId: run.runId, status: 'streaming' })
      pushLog(key, `run ${run.runId.slice(0, 8)}… streaming`)

      await new Promise<void>((resolve) => {
        const url = buildCursorStreamUrl(agent.agentId, run.runId)
        const es = new EventSource(url, { withCredentials: false })
        esRefs.current.set(key, es)

        const onAny = (raw: MessageEvent, type: string) => {
          let payload: any = null
          try {
            payload = JSON.parse(raw.data)
          } catch {
            payload = { type, raw: raw.data }
          }
          handleEvent(key, type, payload, t0, resolve, es)
        }
        es.addEventListener('message', (e) => onAny(e, 'message'))
        for (const t of [
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
        ]) {
          es.addEventListener(t, (e: MessageEvent) => onAny(e, t))
        }
        es.onerror = () => {
          // EventSource auto-retries, but if the server closed the stream
          // intentionally (after 'done') readyState becomes CLOSED.
          if (es.readyState === EventSource.CLOSED) {
            cleanup(key, es)
            resolve()
          }
        }
      })

      const slotNow = readSlot(key)
      if (slotNow && slotNow.status !== 'done' && slotNow.status !== 'error') {
        patch(key, { status: 'done', doneAt: Date.now() })
        pushLog(key, 'stream closed')
      }
    } catch (err) {
      patch(key, {
        status: 'error',
        err: err instanceof Error ? err.message : String(err),
        doneAt: Date.now(),
      })
      pushLog(key, `ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Slots state captured via closure at call-time; use a ref-style read
  function readSlot(key: string): Slot | null {
    let found: Slot | null = null
    setSlots((cur) => {
      found = cur.find((s) => s.key === key) ?? null
      return cur
    })
    return found
  }

  function handleEvent(
    key: string,
    type: string,
    payload: any,
    t0: number,
    resolve: () => void,
    es: EventSource,
  ) {
    setSlots((cur) =>
      cur.map((s) => {
        if (s.key !== key) return s
        const next: Slot = { ...s, events: s.events + 1 }
        if (type === 'tool_call') next.toolCalls = s.toolCalls + 1
        if (type === 'assistant') {
          const blocks = payload?.message?.content ?? payload?.content ?? []
          if (Array.isArray(blocks)) {
            for (const c of blocks) {
              if (c?.type === 'text' && typeof c.text === 'string') {
                next.lastText = c.text.slice(-280)
                next.textChunks = next.textChunks + 1
                if (!s.firstTokenAt) next.firstTokenAt = Date.now() - t0
              }
            }
          }
        }
        if (type === 'status' && payload?.status) {
          next.log = [...s.log.slice(-9), `${stamp()} status=${payload.status}`]
        }
        if (type === 'done') {
          next.status = 'done'
          next.doneAt = Date.now()
          es.close()
          esRefs.current.delete(key)
          queueMicrotask(resolve)
        }
        if (type === 'error') {
          next.status = 'error'
          next.err = String(payload?.error ?? payload)
          next.doneAt = Date.now()
          es.close()
          esRefs.current.delete(key)
          queueMicrotask(resolve)
        }
        return next
      }),
    )
  }

  function cleanup(key: string, es: EventSource) {
    es.close()
    esRefs.current.delete(key)
  }

  async function fanOut() {
    if (running) return
    if (!repoUrl.trim()) return
    setRunning(true)
    setWallMs(null)
    wallStartRef.current = Date.now()
    setSlots((cur) =>
      cur.map((s) => ({
        ...newSlot(s.prompt),
        key: s.key,
      })),
    )
    const t0 = Date.now()
    const snapshot = slots.map((s) => ({ ...s, status: 'idle' as const }))
    await Promise.all(snapshot.map((s) => runSlot(s, t0)))
    setWallMs(Date.now() - t0)
    setRunning(false)
  }

  function stopAll() {
    for (const es of esRefs.current.values()) es.close()
    esRefs.current.clear()
    setSlots((cur) =>
      cur.map((s) =>
        s.status === 'streaming' || s.status === 'sending' || s.status === 'creating'
          ? { ...s, status: 'error', err: 'cancelled', doneAt: Date.now() }
          : s,
      ),
    )
    setRunning(false)
  }

  const summary = summarize(slots, wallMs)

  return (
    <div className="space-y-5">
      <Panel
        title="Cloud Fan-out"
        sub={
          <>
            把同一个 GitHub repo 同时丢给{' '}
            <span className="font-mono">{slots.length}</span> 个 Cursor cloud agent，
            每个跑各自的任务，全部并行。当前 bridge =
            <span className="ml-1 rounded bg-violet-100 px-1.5 py-px font-mono text-[10px] text-violet-800">
              {active.name}
            </span>
          </>
        }
        actions={
          <div className="flex items-center gap-1">
            <button onClick={addSlot} disabled={running} className="btn btn-ghost h-7 text-[11px]">
              <Plus className="h-3 w-3" />
              加一个 slot
            </button>
            {running ? (
              <button onClick={stopAll} className="btn btn-ghost h-7 text-[11px] text-red-600">
                <Square className="h-3 w-3" />
                全部停
              </button>
            ) : (
              <button
                onClick={fanOut}
                disabled={!repoUrl.trim() || slots.length === 0}
                className="btn btn-primary h-7 text-[11px]"
              >
                <Play className="h-3 w-3" />
                开跑 ({slots.length})
              </button>
            )}
            <button onClick={reset} disabled={running} className="btn btn-ghost h-7 text-[11px]">
              <Trash2 className="h-3 w-3" />
              重置
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Repo URL" hint="必须先给 ShukriChiu 装 Cursor Background Agents GitHub App">
            <input
              className="input col-span-2 font-mono text-[12px]"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
            />
          </Field>
          <Field label="Starting Ref">
            <input
              className="input font-mono text-[12px]"
              value={startingRef}
              onChange={(e) => setStartingRef(e.target.value)}
            />
          </Field>
          <Field label="Model">
            <input
              className="input font-mono text-[12px]"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </Field>
          <Field label="Auto PR">
            <label className="flex h-9 items-center gap-2 rounded-md border border-ink-200 bg-white px-2 text-[12px]">
              <input
                type="checkbox"
                checked={autoCreatePR}
                onChange={(e) => setAutoCreatePR(e.target.checked)}
              />
              <span className="text-ink-600">每个 slot 跑完开一个 PR</span>
            </label>
          </Field>
        </div>
      </Panel>

      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="slots" value={String(slots.length)} />
        <Stat label="done" value={`${summary.done}/${slots.length}`} ok={summary.done === slots.length} />
        <Stat label="errors" value={String(summary.errors)} bad={summary.errors > 0} />
        <Stat label="wall (ms)" value={wallMs != null ? String(wallMs) : '—'} />
        <Stat
          label="speedup"
          value={summary.speedup ? `${summary.speedup.toFixed(2)}x` : '—'}
          hint={`vs sum-of-individuals ${summary.sumSerialMs ?? 0}ms`}
        />
      </div>

      {/* Slot grid */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {slots.map((s, i) => (
          <SlotCard
            key={s.key}
            slot={s}
            idx={i}
            disabled={running}
            onRemove={() => removeSlot(s.key)}
            onPromptChange={(v) => patch(s.key, { prompt: v })}
          />
        ))}
      </div>
    </div>
  )
}

function SlotCard({
  slot,
  idx,
  disabled,
  onRemove,
  onPromptChange,
}: {
  slot: Slot
  idx: number
  disabled: boolean
  onRemove: () => void
  onPromptChange: (v: string) => void
}) {
  const elapsed =
    slot.startedAt && slot.doneAt
      ? slot.doneAt - slot.startedAt
      : slot.startedAt
        ? Date.now() - slot.startedAt
        : 0

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border bg-white shadow-sm transition',
        slot.status === 'error' && 'border-red-200',
        slot.status === 'done' && 'border-emerald-200',
        slot.status === 'streaming' && 'border-violet-300 ring-1 ring-violet-100',
        slot.status === 'idle' && 'border-ink-200',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <SlotIcon status={slot.status} />
          <div className="text-[12px] font-semibold text-ink-900">slot #{idx + 1}</div>
          <SlotBadge status={slot.status} />
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-ink-500">
          {slot.firstTokenAt != null && (
            <span title="time to first token">1st {slot.firstTokenAt}ms</span>
          )}
          {elapsed > 0 && <span>· {Math.round(elapsed)}ms</span>}
          <button
            onClick={onRemove}
            disabled={disabled}
            className="rounded p-0.5 hover:bg-ink-100 disabled:opacity-30"
            title="移除"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      <textarea
        className="textarea m-2 mb-1 min-h-[64px] resize-none text-[12px]"
        value={slot.prompt}
        disabled={disabled}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="给这个 cloud agent 的提示词…"
      />

      <div className="grid grid-cols-3 gap-1 px-2 text-[10px] text-ink-500">
        <span>events {slot.events}</span>
        <span>tools {slot.toolCalls}</span>
        <span>text {slot.textChunks}</span>
      </div>

      {slot.lastText && (
        <div className="m-2 rounded-md bg-ink-50 p-2 font-mono text-[11px] leading-snug text-ink-800">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-500">
            last assistant text
          </div>
          <div className="line-clamp-4 whitespace-pre-wrap break-words">{slot.lastText}</div>
        </div>
      )}

      {slot.err && (
        <div className="m-2 flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">{slot.err}</span>
        </div>
      )}

      {slot.log.length > 0 && (
        <div className="m-2 max-h-[80px] overflow-auto rounded-md border border-ink-100 bg-ink-50/40 p-1.5 font-mono text-[10px] leading-tight text-ink-600 scroll-thin">
          {slot.log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {slot.agentId && (
        <div className="border-t border-ink-100 px-3 py-1.5 font-mono text-[10px] text-ink-500">
          {slot.agentId}
        </div>
      )}
    </div>
  )
}

function SlotIcon({ status }: { status: SlotStatus }) {
  if (status === 'creating' || status === 'sending') return <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" />
  if (status === 'streaming') return <Sparkles className="h-3.5 w-3.5 text-violet-600" />
  if (status === 'done') return <Cloud className="h-3.5 w-3.5 text-emerald-600" />
  if (status === 'error') return <AlertCircle className="h-3.5 w-3.5 text-red-600" />
  return <Cloud className="h-3.5 w-3.5 text-ink-400" />
}

function SlotBadge({ status }: { status: SlotStatus }) {
  const map: Record<SlotStatus, string> = {
    idle: 'bg-ink-100 text-ink-600',
    creating: 'bg-violet-100 text-violet-700',
    sending: 'bg-violet-100 text-violet-700',
    streaming: 'bg-violet-100 text-violet-700',
    done: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
  }
  return (
    <span
      className={cn(
        'rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
        map[status],
      )}
    >
      {status}
    </span>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-600">
        {label}
      </label>
      {children}
      {hint && <div className="mt-1 text-[10px] text-ink-500">{hint}</div>}
    </div>
  )
}

function Stat({
  label,
  value,
  ok,
  bad,
  hint,
}: {
  label: string
  value: string
  ok?: boolean
  bad?: boolean
  hint?: string
}) {
  return (
    <div
      className={cn(
        'rounded-md border bg-white px-3 py-2',
        ok && 'border-emerald-200',
        bad && 'border-red-200',
        !ok && !bad && 'border-ink-200',
      )}
      title={hint}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-base font-semibold',
          ok ? 'text-emerald-700' : bad ? 'text-red-700' : 'text-ink-900',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function summarize(slots: Slot[], wallMs: number | null) {
  const done = slots.filter((s) => s.status === 'done').length
  const errors = slots.filter((s) => s.status === 'error').length
  const sumSerialMs = slots.reduce((a, s) => {
    if (s.startedAt && s.doneAt) return a + (s.doneAt - s.startedAt)
    return a
  }, 0)
  const speedup = wallMs && wallMs > 0 ? sumSerialMs / wallMs : null
  return { done, errors, sumSerialMs, speedup }
}

function stamp(): string {
  const d = new Date()
  return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 2)}`
}
