// 把 SSE 过来的 SDKMessage / done / error 折叠成 Cursor 风格的 Turn[] 模型。
// 参考: https://cursor.com/cn/docs/sdk/typescript#streaming

export type ToolStatus = 'running' | 'completed' | 'error'

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs?: number }
  | {
      kind: 'tool_call'
      callId: string
      name: string
      status: ToolStatus
      args?: unknown
      result?: unknown
      truncated?: { args?: boolean; result?: boolean }
    }

export type Turn =
  | { id: string; role: 'user'; text: string }
  | {
      id: string
      role: 'assistant'
      blocks: AssistantBlock[]
      status: 'streaming' | 'done' | 'error' | 'cancelled'
      runId?: string
      result?: string
      durationMs?: number
      lifecycle?: string
    }

interface AssistantContentBlock {
  type: 'text' | 'tool_use'
  text?: string
}
interface AssistantPayload {
  message?: { content?: AssistantContentBlock[] }
}
interface ThinkingPayload {
  text?: string
  thinking_duration_ms?: number
}
interface ToolCallPayload {
  call_id?: string
  name?: string
  status?: ToolStatus
  args?: unknown
  result?: unknown
  truncated?: { args?: boolean; result?: boolean }
}
interface StatusPayload {
  status?: string
  message?: string
}
interface DonePayload {
  status?: 'finished' | 'error' | 'cancelled'
  result?: string
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

export function newUserTurn(text: string): Turn {
  return { id: uid(), role: 'user', text }
}

export function newAssistantTurn(runId?: string): Extract<Turn, { role: 'assistant' }> {
  return { id: uid(), role: 'assistant', blocks: [], status: 'streaming', runId }
}

/**
 * Apply one SSE event to the assistant turn (mutates and returns a new array
 * for React-friendly state updates).
 */
export function applyEvent(
  turns: Turn[],
  type: string,
  payload: unknown,
): Turn[] {
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant') return turns

  // shallow-clone the assistant turn so React picks up the change
  const updated: Extract<Turn, { role: 'assistant' }> = { ...last, blocks: [...last.blocks] }

  switch (type) {
    case 'assistant': {
      const p = payload as AssistantPayload
      const text = (p.message?.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('')
      if (text) appendText(updated, text)
      break
    }
    case 'thinking': {
      const p = payload as ThinkingPayload
      if (p.text) appendThinking(updated, p.text, p.thinking_duration_ms)
      break
    }
    case 'tool_call': {
      const p = payload as ToolCallPayload
      if (!p.call_id || !p.name) break
      upsertToolCall(updated, p)
      break
    }
    case 'status': {
      const p = payload as StatusPayload
      updated.lifecycle = p.status
      if (p.status === 'CANCELLED') updated.status = 'cancelled'
      if (p.status === 'ERROR') updated.status = 'error'
      break
    }
    case 'done': {
      const p = payload as DonePayload
      updated.status = (p.status ?? 'done') as Extract<Turn, { role: 'assistant' }>['status']
      if (p.result) updated.result = p.result
      break
    }
    case 'error': {
      updated.status = 'error'
      const text = typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message?: unknown }).message ?? '')
        : String(payload)
      if (text) appendText(updated, `\n\n[error] ${text}`)
      break
    }
    case 'task':
    case 'user':
    case 'system':
    case 'request':
      // 这几类对 UI 价值低，先忽略；如果以后想要可在这里展开。
      break
  }

  return [...turns.slice(0, -1), updated]
}

function appendText(turn: Extract<Turn, { role: 'assistant' }>, text: string) {
  const last = turn.blocks[turn.blocks.length - 1]
  if (last && last.kind === 'text') {
    turn.blocks[turn.blocks.length - 1] = { kind: 'text', text: last.text + text }
  } else {
    turn.blocks.push({ kind: 'text', text })
  }
}

function appendThinking(
  turn: Extract<Turn, { role: 'assistant' }>,
  text: string,
  durationMs?: number,
) {
  const last = turn.blocks[turn.blocks.length - 1]
  if (last && last.kind === 'thinking') {
    turn.blocks[turn.blocks.length - 1] = {
      kind: 'thinking',
      text: last.text + text,
      durationMs: durationMs ?? last.durationMs,
    }
  } else {
    turn.blocks.push({ kind: 'thinking', text, durationMs })
  }
}

function upsertToolCall(turn: Extract<Turn, { role: 'assistant' }>, p: ToolCallPayload) {
  const idx = turn.blocks.findIndex(
    (b) => b.kind === 'tool_call' && b.callId === p.call_id,
  )
  const next: AssistantBlock = {
    kind: 'tool_call',
    callId: p.call_id!,
    name: p.name!,
    status: p.status ?? 'running',
    args: p.args,
    result: p.result,
    truncated: p.truncated,
  }
  if (idx >= 0) {
    const existing = turn.blocks[idx] as Extract<AssistantBlock, { kind: 'tool_call' }>
    turn.blocks[idx] = {
      ...existing,
      status: next.status,
      args: next.args ?? existing.args,
      result: next.result ?? existing.result,
      truncated: next.truncated ?? existing.truncated,
    }
  } else {
    turn.blocks.push(next)
  }
}
