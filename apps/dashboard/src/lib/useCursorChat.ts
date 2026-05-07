/**
 * Streams a Cursor cloud agent through cursor-bridge and exposes a
 * chat hook the workspace can render directly.
 *
 *   1. SSE wiring — startStreamingRun → EventSource → applyEvent.
 *      Falls back to the synchronous /messages call when the bridge
 *      doesn't expose streaming.
 *   2. Canvas protocol — scan every assistant text block for closed
 *      ```canvas fenced JSON, compile it via `canvasBlockToBundle`,
 *      and surface the result on the right pane. Tool calls stay in
 *      the chat (collapsible rows in WorkspaceChat) and never
 *      auto-promote to artifacts; the canvas is for what the agent
 *      *explicitly* chose to render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Turn,
} from '@/views/agents/conversation/turns'
import type { ArtifactBundle } from '@/views/agents/conversation/artifact/types'
import {
  canvasBlockToBundle,
  extractCanvasBlocks,
} from '@/views/agents/conversation/artifact/canvasProtocol'

interface Options {
  agentId: string
}

/** Public shape consumed by `WorkspaceChat`. */
export interface WorkspaceChatHook {
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

export function useCursorChat({ agentId }: Options): WorkspaceChatHook {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [artifacts, setArtifacts] = useState<ArtifactBundle[]>([])
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const startedAtRef = useRef<number>(0)
  // Per-(turn, hash) dedupe so re-renders or retries of the same canvas
  // block don't pile up duplicate tabs.
  const seenCanvasRef = useRef<Set<string>>(new Set())

  /* ------------------- canvas protocol: text → artifacts ------------------ */

  // Whenever any assistant text block grows, re-scan it for closed
  // ```canvas fences. The extractor is streaming-safe (open blocks are
  // ignored until they close), so it's fine to run on every turn delta.
  useEffect(() => {
    const newBundles: ArtifactBundle[] = []
    let lastNewId: string | null = null
    for (const t of turns) {
      if (t.role !== 'assistant') continue
      for (let i = 0; i < t.blocks.length; i++) {
        const b = t.blocks[i]
        if (b?.kind !== 'text') continue
        const { blocks, hashes } = extractCanvasBlocks(b.text)
        for (let k = 0; k < blocks.length; k++) {
          const h = hashes[k]
          if (!h) continue
          const dedupeKey = `${t.id}:${h}`
          if (seenCanvasRef.current.has(dedupeKey)) continue
          seenCanvasRef.current.add(dedupeKey)
          const id = `canvas-${t.id}-${h}`
          newBundles.push(
            canvasBlockToBundle(blocks[k]!, { id, index: k, turnId: t.id }),
          )
          lastNewId = id
        }
      }
    }
    if (newBundles.length === 0) return
    setArtifacts((prev) => [...prev, ...newBundles])
    if (lastNewId) setActiveArtifactId(lastNewId)
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
    seenCanvasRef.current.clear()
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
