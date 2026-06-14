/**
 * Unified shape over local Rust-runtime agents and Cursor cloud agents.
 *
 * `id` is fully-qualified: `local:<name>` or `cursor:<agentId>`.
 * Use `parseId` to split it back, never split it inline at call sites.
 */

export type AgentKind = 'local' | 'cursor'
export type AgentStatus = 'idle' | 'running' | 'failed' | 'unknown'

export interface UnifiedAgent {
  id: string
  kind: AgentKind
  name: string
  description: string | null
  model: string
  provider: string
  status: AgentStatus
  workspace?: string
  repoUrl?: string
  /** Cursor SDK runtime when `kind === 'cursor'`. */
  cursorRuntime?: 'local' | 'cloud'
  cwd?: string
  toolsCount?: number
  raw: unknown
}

export function makeId(kind: AgentKind, name: string): string {
  return `${kind}:${name}`
}

export function parseId(id: string): { kind: AgentKind; name: string } | null {
  const idx = id.indexOf(':')
  if (idx < 0) return null
  const kind = id.slice(0, idx) as AgentKind
  if (kind !== 'local' && kind !== 'cursor') return null
  return { kind, name: id.slice(idx + 1) }
}
