/**
 * Storage layer for `apps/future`.
 *
 * V1 ships against `apps/backend`'s composite endpoint:
 *
 *   GET  /v1/future/state   →  WarRoomData
 *   PUT  /v1/future/state   →  WarRoomData (server returns canonical state)
 *
 * State is per-tenant on the server. The active tenant is whichever the
 * caller's session is pinned to (managed by `lib/auth-context.tsx`).
 *
 * Import / export still produce a JSON file so users can hand-edit data
 * or seed a fresh tenant.
 */

import { backend } from './backend'
import type { WarRoomData } from './types'

export async function loadData(): Promise<WarRoomData> {
  return await backend.getFutureState()
}

export async function saveData(data: WarRoomData): Promise<WarRoomData> {
  return await backend.putFutureState(data)
}

export function exportData(data: WarRoomData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `shujian-future-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export async function importData(file: File): Promise<WarRoomData> {
  const text = await file.text()
  const parsed = JSON.parse(text) as Partial<WarRoomData>
  return {
    students: parsed.students ?? [],
    projects: parsed.projects ?? [],
    squads: parsed.squads ?? [],
    feedback: parsed.feedback ?? [],
  }
}

export function safeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
