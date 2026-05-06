/**
 * Bridge registry.
 *
 * A "bridge" = one shujian-agent-bridge instance that wraps a Cursor account.
 *
 *   id          stable internal id
 *   name        human-friendly label ("local", "macmini-studio", "cloud-pool")
 *   endpoint    where to reach it. For the embedded local bridge, use the
 *               special string "/cursor" so Vite's dev proxy still works.
 *               For remote bridges, use a full origin (https://...).
 *   apiKey      the Cursor API key bound to THIS bridge
 *   sessionToken (optional) the cursor.com WorkosCursorSessionToken cookie,
 *               needed only if you want the rich /usage billing breakdown
 *
 * One bridge is "active" at a time — the dashboard sends every cursor-bridge
 * request to it. Switching bridge = switching which Cursor account drives
 * the next agent run.
 */

const STORAGE_KEY = 'shujian.bridges.v1'
const ACTIVE_KEY = 'shujian.bridges.active.v1'
const LEGACY_CRED_KEY = 'shujian.cursor.credentials.v1'
const EVT = 'shujian-bridges-changed'

export interface Bridge {
  id: string
  name: string
  endpoint: string
  apiKey: string
  sessionToken: string
}

export const LOCAL_ENDPOINT = '/cursor'

const DEFAULT_LOCAL: Bridge = Object.freeze({
  id: 'local',
  name: 'local',
  endpoint: LOCAL_ENDPOINT,
  apiKey: '',
  sessionToken: '',
}) as Bridge

interface State {
  bridges: Bridge[]
  activeId: string
}

let cache: State | null = null

function read(): State {
  if (cache) return cache
  if (typeof window === 'undefined') {
    cache = { bridges: [DEFAULT_LOCAL], activeId: DEFAULT_LOCAL.id }
    return cache
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    let bridges: Bridge[] = []
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Bridge>[]
      bridges = parsed.filter((b): b is Bridge => !!b && !!b.id && !!b.endpoint).map((b) => ({
        id: b.id!,
        name: b.name ?? b.id!,
        endpoint: b.endpoint!,
        apiKey: b.apiKey ?? '',
        sessionToken: b.sessionToken ?? '',
      }))
    }
    if (bridges.length === 0) {
      // Migrate from the old single-credentials store, if present.
      const legacy = window.localStorage.getItem(LEGACY_CRED_KEY)
      if (legacy) {
        try {
          const c = JSON.parse(legacy) as { apiKey?: string; sessionToken?: string }
          bridges = [{ ...DEFAULT_LOCAL, apiKey: c.apiKey ?? '', sessionToken: c.sessionToken ?? '' }]
        } catch {
          bridges = [{ ...DEFAULT_LOCAL }]
        }
      } else {
        bridges = [{ ...DEFAULT_LOCAL }]
      }
    }
    let activeId = window.localStorage.getItem(ACTIVE_KEY) ?? bridges[0]!.id
    if (!bridges.some((b) => b.id === activeId)) activeId = bridges[0]!.id
    cache = { bridges, activeId }
  } catch {
    cache = { bridges: [{ ...DEFAULT_LOCAL }], activeId: DEFAULT_LOCAL.id }
  }
  return cache
}

function persist(state: State) {
  cache = state
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.bridges))
    window.localStorage.setItem(ACTIVE_KEY, state.activeId)
  } catch {
    // private mode — keep memory only
  }
  window.dispatchEvent(new CustomEvent(EVT))
}

export function listBridges(): Bridge[] {
  return read().bridges
}

export function getActiveBridgeId(): string {
  return read().activeId
}

export function getActiveBridge(): Bridge {
  const s = read()
  return s.bridges.find((b) => b.id === s.activeId) ?? s.bridges[0] ?? { ...DEFAULT_LOCAL }
}

export function setActiveBridge(id: string): void {
  const s = read()
  if (!s.bridges.some((b) => b.id === id)) return
  persist({ ...s, activeId: id })
}

export function upsertBridge(b: Bridge): void {
  const s = read()
  const idx = s.bridges.findIndex((x) => x.id === b.id)
  const next = idx >= 0
    ? [...s.bridges.slice(0, idx), b, ...s.bridges.slice(idx + 1)]
    : [...s.bridges, b]
  persist({ bridges: next, activeId: s.activeId })
}

export function removeBridge(id: string): void {
  const s = read()
  if (s.bridges.length <= 1) return // never empty the list
  const next = s.bridges.filter((b) => b.id !== id)
  const activeId = s.activeId === id ? next[0]!.id : s.activeId
  persist({ bridges: next, activeId })
}

/** Update only the active bridge's credentials — used by the legacy
 *  CredentialsDialog so it now edits the active bridge in-place. */
export function setActiveCredentials(creds: { apiKey?: string; sessionToken?: string }): void {
  const s = read()
  const idx = s.bridges.findIndex((b) => b.id === s.activeId)
  if (idx < 0) return
  const merged: Bridge = {
    ...s.bridges[idx]!,
    apiKey: creds.apiKey ?? s.bridges[idx]!.apiKey,
    sessionToken: creds.sessionToken ?? s.bridges[idx]!.sessionToken,
  }
  const next = [...s.bridges.slice(0, idx), merged, ...s.bridges.slice(idx + 1)]
  persist({ bridges: next, activeId: s.activeId })
}

export function clearActiveCredentials(): void {
  setActiveCredentials({ apiKey: '', sessionToken: '' })
}

export function onBridgesChange(listener: () => void): () => void {
  window.addEventListener(EVT, listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === ACTIVE_KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Resolve the URL prefix used for cursor-bridge HTTP calls. */
export function cursorBase(): string {
  return getActiveBridge().endpoint || LOCAL_ENDPOINT
}

/** Build the Cursor auth headers for the active bridge. */
export function cursorAuthHeaders(): Record<string, string> {
  const b = getActiveBridge()
  const h: Record<string, string> = {}
  if (b.apiKey) h['X-Cursor-Api-Key'] = b.apiKey
  if (b.sessionToken) h['X-Cursor-Session-Token'] = b.sessionToken
  return h
}

export function genId(): string {
  return `b_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36).slice(-4)}`
}
