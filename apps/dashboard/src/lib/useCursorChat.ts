/**
 * Drop-in replacement for `useMockChat` that talks to a real Cursor
 * cloud agent through cursor-bridge.
 *
 * Public shape mirrors `UseMockChatReturn` so `WorkspaceChat` can use
 * either hook without branching. The two extra concerns this hook
 * handles vs. the mock:
 *
 *   1. SSE wiring — startStreamingRun → EventSource → applyEvent.
 *      Falls back to the synchronous /messages call when the bridge
 *      doesn't expose streaming.
 *   2. Surface tool_call results as `ArtifactBundle`s in the right
 *      pane. Real cursor tools don't (yet) emit dashboard-shaped
 *      artifacts, so we synthesize a basic "tool result" artifact per
 *      completed tool_call. When real tools start emitting structured
 *      results we'll switch to a `kind: 'agent_tool'` capability source.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Spec } from '@json-render/core'
import {
  buildCursorStreamUrl,
  buildCursorStreamUrlWithAuth,
  cursorApi,
  type CursorMessageResult,
} from './api'
import { LOCAL_ENDPOINT } from './bridges'
import {
  applyEvent,
  newAssistantTurn,
  newUserTurn,
  type AssistantBlock,
  type Turn,
} from '@/views/agents/conversation/turns'
import type { ArtifactBundle } from '@/views/agents/conversation/artifact/mock-data'
import type { UseMockChatReturn } from '@/views/agents/conversation/artifact/useMockChat'

interface Options {
  agentId: string
}

/** Best-effort detection: are we proxying the bridge through Vite? */
function localBridge(): boolean {
  if (typeof window === 'undefined') return true
  if (!LOCAL_ENDPOINT) return true
  try {
    const stored = localStorage.getItem('shujian.bridges.v1')
    if (!stored) return true
    const data = JSON.parse(stored) as { activeEndpoint?: string }
    return !data?.activeEndpoint || data.activeEndpoint.startsWith('/')
  } catch {
    return true
  }
}

export function useCursorChat({ agentId }: Options): UseMockChatReturn {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [artifacts, setArtifacts] = useState<ArtifactBundle[]>([])
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const startedAtRef = useRef<number>(0)
  const seenToolCallsRef = useRef<Set<string>>(new Set())

  /* ------------------------- collect tool artifacts ----------------------- */

  // Whenever the latest assistant turn picks up a `completed` tool_call
  // we haven't surfaced yet, drop a corresponding artifact into the
  // right pane. This is intentionally loose — real Cursor tools return
  // anything; we render their result through a generic JSON viewer.
  useEffect(() => {
    const last = turns[turns.length - 1]
    if (!last || last.role !== 'assistant') return
    for (const block of last.blocks) {
      if (block.kind !== 'tool_call') continue
      if (block.status !== 'completed') continue
      if (seenToolCallsRef.current.has(block.callId)) continue
      seenToolCallsRef.current.add(block.callId)
      setArtifacts((prev) => [
        ...prev,
        toolCallToArtifact(block, last.id),
      ])
      setActiveArtifactId(`tool-${block.callId}`)
    }
  }, [turns])

  /* ------------------------- streaming machinery ------------------------- */

  const stop = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setBusy(false)
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || last.status !== 'streaming') return prev
      return [...prev.slice(0, -1), { ...last, status: 'cancelled' }]
    })
  }, [])

  useEffect(
    () => () => {
      esRef.current?.close()
      esRef.current = null
    },
    [],
  )

  const send = useCallback(
    (message: string) => {
      const text = message.trim()
      if (!text || busy) return
      setBusy(true)
      startedAtRef.current = performance.now()
      setTurns((prev) => [...prev, newUserTurn(text), newAssistantTurn()])

      ;(async () => {
        try {
          const { runId } = await cursorApi.startStreamingRun(agentId, text)
          setTurns((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            return [...prev.slice(0, -1), { ...last, runId }]
          })

          const url = localBridge()
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
            if (esRef.current === es) {
              es.close()
              esRef.current = null
              setBusy(false)
            }
          }
        } catch (err) {
          // bridge missing /runs → fall back to one-shot send
          try {
            const res: CursorMessageResult = await cursorApi.send(agentId, text)
            const ms = Math.round(performance.now() - startedAtRef.current)
            setTurns((prev) => {
              const last = prev[prev.length - 1]
              if (!last || last.role !== 'assistant') return prev
              const synthetic: Extract<Turn, { role: 'assistant' }> = {
                ...last,
                status: res.status === 'finished' ? 'done' : 'error',
                durationMs: res.durationMs ?? ms,
                result: res.result,
                blocks: res.result
                  ? [{ kind: 'text', text: res.result }]
                  : [{ kind: 'text', text: '(no result)' }],
              }
              return [...prev.slice(0, -1), synthetic]
            })
          } catch (fallbackErr) {
            const msg =
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
            setTurns((prev) => {
              const last = prev[prev.length - 1]
              if (!last || last.role !== 'assistant') return prev
              const synthetic: Extract<Turn, { role: 'assistant' }> = {
                ...last,
                status: 'error',
                blocks: [{ kind: 'text', text: `[error] ${msg}` }],
              }
              return [...prev.slice(0, -1), synthetic]
            })
          } finally {
            setBusy(false)
          }
          console.debug('[useCursorChat] streaming start failed, used fallback', err)
        }
      })()
    },
    [agentId, busy],
  )

  const selectArtifact = useCallback((id: string) => setActiveArtifactId(id), [])

  const removeArtifact = useCallback(
    (id: string) => {
      setArtifacts((prev) => prev.filter((a) => a.id !== id))
      setActiveArtifactId((cur) => (cur === id ? null : cur))
    },
    [],
  )

  const reset = useCallback(() => {
    stop()
    setTurns([])
    setArtifacts([])
    setActiveArtifactId(null)
    seenToolCallsRef.current.clear()
  }, [stop])

  return useMemo(
    () => ({
      turns,
      busy,
      artifacts,
      activeArtifactId,
      send,
      stop,
      selectArtifact,
      removeArtifact,
      reset,
    }),
    [turns, busy, artifacts, activeArtifactId, send, stop, selectArtifact, removeArtifact, reset],
  )
}

/* -------------------------------------------------------------------------- */
/* Map a completed tool_call into a generic artifact for the right pane.      */
/* -------------------------------------------------------------------------- */

function toolCallToArtifact(
  block: Extract<AssistantBlock, { kind: 'tool_call' }>,
  turnId: string,
): ArtifactBundle {
  const summary = summarizeUnknown(block.result)
  // Render the tool result inside a Frame > Stack > Heading + Text pair.
  // Keeping spec generic until we have a proper agent_tool ↔ capability
  // bridge.
  const spec: Spec = {
    root: 'root',
    elements: {
      root: {
        type: 'Frame',
        props: { title: block.name, subtitle: 'tool call · live' },
        slots: { default: ['stack'] },
      },
      stack: {
        type: 'Stack',
        props: { gap: 'md' },
        slots: { default: ['args', 'result'] },
      },
      args: {
        type: 'Text',
        props: {
          text: '**input**\n\n```json\n' + safeStringify(block.args) + '\n```',
          variant: 'body',
        },
      },
      result: {
        type: 'Text',
        props: {
          text: '**result**\n\n```json\n' + safeStringify(block.result) + '\n```',
          variant: 'body',
        },
      },
    },
  } as unknown as Spec

  return {
    id: `tool-${block.callId}`,
    // ArtifactKind is a closed union in mock-data; pick the closest
    // bucket so existing styling works. The artifact pane doesn't
    // actually branch on `kind`, only on `spec`.
    kind: 'staff',
    title: `${block.name}`,
    summary,
    narrative: `工具调用 \`${block.name}\` 在 turn ${turnId} 完成。`,
    spec,
    followups: [],
  }
}

function summarizeUnknown(value: unknown): string {
  if (value === null || value === undefined) return '(empty)'
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length === 0 ? '{}' : `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }`
  }
  return String(value)
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 2)
    return s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s
  } catch {
    return String(value)
  }
}
