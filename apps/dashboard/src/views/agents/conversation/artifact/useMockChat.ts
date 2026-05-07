import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyEvent,
  newAssistantTurn,
  newUserTurn,
  type Turn,
} from '../turns'
import { type ArtifactBundle, ARTIFACTS } from './mock-data'
import { type MockTurnEvent, planFromPrompt } from './mock-tool'

export interface UseMockChatReturn {
  turns: Turn[]
  busy: boolean
  artifacts: ArtifactBundle[]
  activeArtifactId: string | null
  send: (prompt: string) => void
  stop: () => void
  selectArtifact: (id: string) => void
  removeArtifact: (id: string) => void
  reset: () => void
}

/**
 * Local "agent" simulator: takes a user prompt, picks an artifact via
 * keyword heuristics, then streams thinking → tool_call → text events
 * onto the existing Turn[] state. Artifacts are surfaced via a separate
 * stream so the workspace can render them in the right pane.
 */
export function useMockChat(): UseMockChatReturn {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [artifacts, setArtifacts] = useState<ArtifactBundle[]>([])
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const timeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const clearTimers = useCallback(() => {
    for (const t of timeoutsRef.current) clearTimeout(t)
    timeoutsRef.current.clear()
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const stop = useCallback(() => {
    cancelRef.current = true
    clearTimers()
    setBusy(false)
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || last.status !== 'streaming') return prev
      return [...prev.slice(0, -1), { ...last, status: 'cancelled' }]
    })
  }, [clearTimers])

  const send = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim()
      if (!trimmed || busy) return
      cancelRef.current = false

      const plan = planFromPrompt(trimmed)
      const userTurn = newUserTurn(trimmed)
      const assistantTurn = newAssistantTurn()
      setTurns((prev) => [...prev, userTurn, assistantTurn])
      setBusy(true)

      if (!plan) {
        // Fallback: graceful "I don't know" reply.
        const t = setTimeout(() => {
          setTurns((prev) =>
            applyEvent(prev, 'assistant', {
              message: {
                content: [
                  {
                    type: 'text',
                    text:
                      '这个问题暂时还没接到 vaults 数据。试试问：\n\n' +
                      '- "Q3 营收情况"\n- "退款主要原因"\n- "未消课时风险"\n- "员工绩效"',
                  },
                ],
              },
            }),
          )
          setTurns((prev) => applyEvent(prev, 'done', { status: 'finished' }))
          setBusy(false)
        }, 320)
        timeoutsRef.current.add(t)
        return
      }

      // Schedule each event with cumulative delays.
      let cumulative = 0
      for (const ev of plan.events) {
        cumulative += ev.delayMs
        const handle = setTimeout(() => {
          if (cancelRef.current) return
          dispatchEvent(ev, plan.bundle, setTurns, setArtifacts, setActiveArtifactId)
          if (ev.type === 'done') setBusy(false)
        }, cumulative)
        timeoutsRef.current.add(handle)
      }
    },
    [busy],
  )

  const selectArtifact = useCallback((id: string) => {
    setActiveArtifactId(id || null)
  }, [])

  const removeArtifact = useCallback((id: string) => {
    setArtifacts((prev) => {
      const next = prev.filter((a) => a.id !== id)
      setActiveArtifactId((current) => {
        if (current !== id) return current
        return next.length ? next[next.length - 1].id : null
      })
      return next
    })
  }, [])

  const reset = useCallback(() => {
    cancelRef.current = true
    clearTimers()
    setTurns([])
    setArtifacts([])
    setActiveArtifactId(null)
    setBusy(false)
  }, [clearTimers])

  return {
    turns,
    busy,
    artifacts,
    activeArtifactId,
    send,
    stop,
    selectArtifact,
    removeArtifact,
    reset,
  }
}

function dispatchEvent(
  ev: MockTurnEvent,
  bundle: ArtifactBundle,
  setTurns: (fn: (prev: Turn[]) => Turn[]) => void,
  setArtifacts: (fn: (prev: ArtifactBundle[]) => ArtifactBundle[]) => void,
  setActiveArtifactId: (id: string | null) => void,
) {
  switch (ev.type) {
    case 'thinking': {
      const p = ev.payload as { text: string }
      setTurns((prev) =>
        applyEvent(prev, 'thinking', { text: p.text, thinking_duration_ms: 0 }),
      )
      break
    }
    case 'tool_start': {
      const p = ev.payload as { callId: string; name: string; args: unknown }
      setTurns((prev) =>
        applyEvent(prev, 'tool_call', {
          call_id: p.callId,
          name: p.name,
          status: 'running',
          args: p.args,
        }),
      )
      break
    }
    case 'tool_done': {
      const p = ev.payload as { callId: string; result: unknown }
      setTurns((prev) =>
        applyEvent(prev, 'tool_call', {
          call_id: p.callId,
          // re-pass the name so applyEvent's guard (call_id + name) doesn't bail.
          // The upsert merges, so we look up the existing block to grab `name`.
          name: 'query_business',
          status: 'completed',
          result: p.result,
        }),
      )
      break
    }
    case 'artifact': {
      const a = ev.payload as ArtifactBundle
      setArtifacts((prev) => {
        if (prev.some((p) => p.id === a.id)) return prev
        return [...prev, a]
      })
      setActiveArtifactId(a.id)
      break
    }
    case 'text': {
      const p = ev.payload as { text: string }
      setTurns((prev) =>
        applyEvent(prev, 'assistant', {
          message: { content: [{ type: 'text', text: p.text }] },
        }),
      )
      break
    }
    case 'done':
      setTurns((prev) =>
        applyEvent(prev, 'done', { status: 'finished', result: bundle.summary }),
      )
      break
  }
}

/** Pre-baked seed prompts shown in the empty state. */
export const SEED_PROMPTS = [
  { kind: 'revenue' as const, label: 'Q3 营收情况' },
  { kind: 'refund' as const, label: '退款主要原因' },
  { kind: 'unconsumed' as const, label: '未消课时风险' },
  { kind: 'staff' as const, label: '员工绩效' },
] satisfies Array<{ kind: keyof typeof ARTIFACTS; label: string }>
