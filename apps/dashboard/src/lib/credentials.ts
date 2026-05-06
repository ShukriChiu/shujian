/**
 * Compatibility shim. The dashboard now stores credentials per-bridge in
 * `bridges.ts`. Existing call sites that read/write a single global pair
 * are routed to the *active* bridge so they keep working unchanged.
 */
import {
  clearActiveCredentials,
  getActiveBridge,
  onBridgesChange,
  setActiveCredentials,
} from './bridges'

export interface Credentials {
  apiKey: string
  sessionToken: string
}

let snapshot: Credentials = { apiKey: '', sessionToken: '' }

function refresh(): Credentials {
  const b = getActiveBridge()
  if (b.apiKey !== snapshot.apiKey || b.sessionToken !== snapshot.sessionToken) {
    snapshot = { apiKey: b.apiKey, sessionToken: b.sessionToken }
  }
  return snapshot
}

if (typeof window !== 'undefined') {
  refresh()
  onBridgesChange(refresh)
}

export function getCredentials(): Credentials {
  return refresh()
}

export function setCredentials(next: Partial<Credentials>): Credentials {
  setActiveCredentials(next)
  return refresh()
}

export function clearCredentials(): void {
  clearActiveCredentials()
  refresh()
}

export function onCredentialsChange(listener: () => void): () => void {
  return onBridgesChange(listener)
}

export function authHeaders(): Record<string, string> {
  const c = refresh()
  const h: Record<string, string> = {}
  if (c.apiKey) h['X-Cursor-Api-Key'] = c.apiKey
  if (c.sessionToken) h['X-Cursor-Session-Token'] = c.sessionToken
  return h
}
