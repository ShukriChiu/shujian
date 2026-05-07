/**
 * .env-style text parser + vault-name/kind detection for the bulk import UI.
 *
 * Mirrors `scripts/import_vault_secrets.py` behaviour 1:1 so users get the
 * same plan whether they use the CLI or paste into the dashboard. Keep the
 * two in sync if you change either.
 */

import type { SecretKind } from './serverVaults'

export interface RawPair {
  key: string
  value: string
  /** 1-based source line number, useful for error messages. */
  line: number
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/

/**
 * Parse pasted .env text. Supports:
 *   - `KEY=value`
 *   - `export KEY=value`
 *   - quoted values (single or double); double-quoted decodes \n / \" / \\
 *   - trailing `# comment` outside of quotes
 *   - blank / `#` lines are skipped
 */
export function parseDotenv(text: string): RawPair[] {
  const out: RawPair[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const m = ENV_LINE.exec(raw)
    if (!m) continue
    const key = m[1]
    let val = m[2] ?? ''
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) {
      const quote = val[0]
      val = val.slice(1, -1)
      if (quote === '"') {
        val = val
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      }
    }
    out.push({ key, value: val, line: i + 1 })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// "Looks public/non-secret" detection — used to dim/hide constants like
// LANGFUSE_BASE_URL that don't need to live in the encrypted vault.
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_KEY_SUFFIXES = ['_BASE_URL', '_PUBLIC_URL', '_PUBLIC_KEY', '_HOST']

export function looksPublic(key: string, value: string): boolean {
  const upper = key.toUpperCase()
  if (PUBLIC_KEY_SUFFIXES.some((s) => upper.endsWith(s))) return true
  // Plain http(s) constants (no embedded credentials, short-ish) are usually
  // base URLs — secret-bearing URLs (DATABASE_URL, signed webhooks) contain
  // an `@` or are postgresql://… so this is conservative.
  if (
    (value.startsWith('http://') || value.startsWith('https://')) &&
    value.length < 200 &&
    !value.includes('@')
  ) {
    return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a source KEY to a vault name, with namespacing.
 *
 *   to_vault_name("ONION_API_KEY",   "onion.")  → "onion.api_key"        (collapsed)
 *   to_vault_name("DATABASE_URL",    "onion.")  → "onion.database.url"
 *   to_vault_name("R2_ACCESS_KEY_ID","onion.")  → "onion.r2.access_key_id"
 *
 * Rule: lowercase the key, replace the FIRST `_` with `.` for namespacing.
 * If the leading word equals the prefix word (e.g. "ONION" + "onion."), drop
 * it to avoid `onion.onion.api_key`.
 */
export function toVaultName(key: string, prefix: string): string {
  const lower = key.toLowerCase()
  const normPrefix = prefix.endsWith('.') || prefix === '' ? prefix : `${prefix}.`
  const idx = lower.indexOf('_')
  if (idx < 0) return `${normPrefix}${lower}`
  const head = lower.slice(0, idx)
  const tail = lower.slice(idx + 1)
  const prefixWord = normPrefix.replace(/\.$/, '').toLowerCase()
  if (head && head === prefixWord) return `${normPrefix}${tail}`
  return `${normPrefix}${head}.${tail}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Kind detection. Order matters: r2_secret beats oauth for r2.secret_access_key.
// ─────────────────────────────────────────────────────────────────────────────

const KIND_RULES: Array<[RegExp, SecretKind]> = [
  [/(^|\.)r2\./, 'r2_secret'],
  [/\.(bot_configs?|webhook|hook)$/, 'webhook'],
  [/\.(jwt_secret|signing_key)$/, 'jwt_signing'],
  [/\.(client_secret|client_id|api_key|access_token)$/, 'oauth'],
]

export function detectKind(name: string): SecretKind {
  for (const [pattern, kind] of KIND_RULES) {
    if (pattern.test(name)) return kind
  }
  return 'env'
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the planned set of vault writes from raw text.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanRow {
  srcKey: string
  srcLine: number
  name: string
  kind: SecretKind
  value: string
  /** True if we'd skip this row by default (constant / public). */
  isPublic: boolean
  /** True if a vault entry with this name already exists (collision). */
  exists: boolean
}

export interface BuildPlanOptions {
  prefix: string
  /** Set of source KEYs the user explicitly chose to skip. */
  skipKeys?: ReadonlySet<string>
  /** Set of vault names that already exist on the server. */
  existingNames?: ReadonlySet<string>
}

export function buildPlan(pairs: RawPair[], opts: BuildPlanOptions): PlanRow[] {
  const skip = opts.skipKeys ?? new Set<string>()
  const existing = opts.existingNames ?? new Set<string>()
  const seen = new Set<string>()
  const rows: PlanRow[] = []
  for (const pair of pairs) {
    if (skip.has(pair.key)) continue
    const name = toVaultName(pair.key, opts.prefix)
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({
      srcKey: pair.key,
      srcLine: pair.line,
      name,
      kind: detectKind(name),
      value: pair.value,
      isPublic: looksPublic(pair.key, pair.value),
      exists: existing.has(name),
    })
  }
  return rows
}

/** "abc…xyz (42 chars)"-style preview that hides the middle. */
export function maskValue(value: string): string {
  if (!value) return '∅'
  if (value.length <= 6) return '·'.repeat(value.length)
  return `${value.slice(0, 3)}…${value.slice(-3)} (${value.length} chars)`
}
