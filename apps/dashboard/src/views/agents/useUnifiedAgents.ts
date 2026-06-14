import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { agentApi, cursorApi, type AgentDto, type CursorAgent } from '@/lib/api'
import { makeId, type UnifiedAgent } from './types'

export function useUnifiedAgents() {
  const local = useQuery({
    queryKey: ['agent', 'agents'],
    queryFn: agentApi.agents,
    retry: 0,
  })
  const status = useQuery({
    queryKey: ['agent', 'status'],
    queryFn: agentApi.status,
    refetchInterval: 6_000,
    retry: 0,
  })
  const cursor = useQuery({
    queryKey: ['cursor', 'list'],
    queryFn: cursorApi.list,
    refetchInterval: 5_000,
    retry: 0,
  })

  const items = useMemo<UnifiedAgent[]>(() => {
    const out: UnifiedAgent[] = []
    const activeLocal = new Set(
      (status.data?.active_tasks ?? []).map((t) => t.agent),
    )
    for (const a of local.data ?? []) {
      out.push(toLocalUnified(a, activeLocal.has(a.name)))
    }
    for (const a of cursor.data?.items ?? []) {
      out.push(toCursorUnified(a))
    }
    return out
  }, [local.data, status.data, cursor.data])

  return {
    items,
    counts: {
      total: items.length,
      local: items.filter((i) => i.kind === 'local').length,
      cursor: items.filter((i) => i.kind === 'cursor').length,
      running: items.filter((i) => i.status === 'running').length,
    },
    queries: { local, cursor, status },
    isLoading: local.isLoading && cursor.isLoading,
  }
}

function toLocalUnified(a: AgentDto, running: boolean): UnifiedAgent {
  return {
    id: makeId('local', a.name),
    kind: 'local',
    name: a.name,
    description: a.description,
    model: a.effective_model.split(':')[0] ?? a.effective_model,
    provider: a.effective_provider,
    status: running ? 'running' : 'idle',
    workspace: a.workspace,
    toolsCount: a.tools?.length,
    raw: a,
  }
}

function toCursorUnified(a: CursorAgent): UnifiedAgent {
  const runtime = a.runtime ?? 'local'
  const displayName = a.name?.trim() || a.agentId
  return {
    id: makeId('cursor', a.agentId),
    kind: 'cursor',
    name: displayName,
    description: null,
    model: a.model?.id ?? 'unknown',
    provider: runtime === 'local' ? 'cursor local' : 'cursor cloud',
    status: 'idle',
    cursorRuntime: runtime,
    cwd: a.cwd,
    repoUrl: a.repoUrl,
    workspace: runtime === 'local' ? a.cwd : a.repoUrl,
    raw: a,
  }
}
