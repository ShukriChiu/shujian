/**
 * Browser-side cache of a successful persona launch.
 *
 * The wizard calls `/v1/personas/:slug/issue`, gets back an
 * `IssuanceResponse` (env vars + JWT metadata), then hands the env to
 * cursor-bridge and records the cursor_agent_id back to the backend.
 * The workspace then needs that same env to:
 *   - render manifest-driven capabilities (kpi_grid → http_get →
 *     `Authorization: Bearer {ONION_API_TOKEN}`),
 *   - show JWT countdown / "expires in 23m" pills,
 *   - re-issue when the timer drains.
 *
 * We could re-call `revealEnv(slug)` on every workspace mount, but every
 * call burns a fresh JWT. Instead we cache the issued env in
 * `sessionStorage` keyed by `agentId`, and only call `revealEnv` when
 * the cache is missing or expired.
 *
 * sessionStorage (not localStorage) because:
 *   - tab close = JWTs gone with the tab, smaller blast radius;
 *   - we don't want a logged-out user to be able to F5 and pick up
 *     yesterday's JWT.
 */

import type { ResolvedEnvVar, CursorSettings, IssuanceResponse } from './serverPersonas'

const PREFIX = 'shujian:issuance:v1:'

export interface IssuanceBundle {
  /** Cursor cloud agent_id this issuance was launched into. */
  agentId: string
  /** Persona slug that issued the env. */
  personaSlug: string
  /** Backend `vault_issuance_log.id` — pass to revoke. */
  issuanceId: string
  /** Earliest minted-JWT expiry, unix seconds. null = no JWTs minted. */
  minExpiresAt: number | null
  /** All JWT IDs across bindings (for revocation). */
  jtis: string[]
  /** Resolved env (with plaintext values). */
  env: ResolvedEnvVar[]
  /** Effective cursor launch settings (merged persona + wizard overrides). */
  cursorSettings: CursorSettings
  /** When this row was put into sessionStorage, unix ms. */
  cachedAt: number
}

function key(agentId: string): string {
  return `${PREFIX}${agentId}`
}

/** Build a flat `Record<string, string>` of env values, suitable for
 *  `cursorApi.create({ envVars })` or `substituteEnv`. Skips entries
 *  without a plaintext `value`. */
export function envToRecord(env: ResolvedEnvVar[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of env) {
    if (e.value !== null && e.value !== undefined) out[e.env] = e.value
  }
  return out
}

/** Persist the wizard's issuance for the workspace. Idempotent. */
export function saveIssuanceBundle(bundle: IssuanceBundle): void {
  try {
    sessionStorage.setItem(key(bundle.agentId), JSON.stringify(bundle))
  } catch {
    // sessionStorage may be disabled (Safari private mode etc.) — the
    // workspace will fall back to revealEnv on demand.
  }
}

/** Read a cached bundle; returns null when missing or unparseable. */
export function readIssuanceBundle(agentId: string): IssuanceBundle | null {
  try {
    const raw = sessionStorage.getItem(key(agentId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as IssuanceBundle
    if (!parsed || typeof parsed !== 'object' || !parsed.env) return null
    return parsed
  } catch {
    return null
  }
}

export function clearIssuanceBundle(agentId: string): void {
  try {
    sessionStorage.removeItem(key(agentId))
  } catch {
    /* noop */
  }
}

/** True when at least one JWT has expired (or all-expired). Static-only
 *  bundles return false because they have no expiry. */
export function isBundleExpired(bundle: IssuanceBundle, nowMs = Date.now()): boolean {
  if (bundle.minExpiresAt === null) return false
  return bundle.minExpiresAt * 1000 <= nowMs
}

/** Build a bundle from an `/issue` response and the chosen cursor agent. */
export function bundleFromIssuance(args: {
  issuance: IssuanceResponse
  agentId: string
  personaSlug: string
}): IssuanceBundle {
  return {
    agentId: args.agentId,
    personaSlug: args.personaSlug,
    issuanceId: args.issuance.id,
    minExpiresAt: args.issuance.min_expires_at,
    jtis: args.issuance.jtis,
    env: args.issuance.env,
    cursorSettings: args.issuance.cursor_settings,
    cachedAt: Date.now(),
  }
}
