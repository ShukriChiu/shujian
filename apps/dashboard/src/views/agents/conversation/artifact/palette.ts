/**
 * Resolve chart colors from CSS custom properties so charts re-tint on
 * theme switch without re-rendering. Recharts accepts plain CSS color
 * strings — `oklch(...)` works in modern browsers.
 *
 * The palette is ordered to match an "accent → cool → warm" rhythm; the
 * first 3 colors share a hue family with the brand (warm orange) so
 * single-series charts feel native to the dashboard.
 */

const TOKENS = [
  '--chart-1', // accent (warm)
  '--chart-2', // teal
  '--chart-3', // amber-soft
  '--chart-4', // violet
  '--chart-5', // sage
  '--chart-6', // rose
] as const

const FALLBACKS: Record<(typeof TOKENS)[number], string> = {
  '--chart-1': 'oklch(0.752 0.158 56)',
  '--chart-2': 'oklch(0.708 0.118 198)',
  '--chart-3': 'oklch(0.815 0.122 92)',
  '--chart-4': 'oklch(0.658 0.142 290)',
  '--chart-5': 'oklch(0.748 0.092 145)',
  '--chart-6': 'oklch(0.682 0.158 18)',
}

export function chartColor(index: number): string {
  const token = TOKENS[index % TOKENS.length]
  if (typeof window === 'undefined') return FALLBACKS[token]
  const styles = getComputedStyle(document.documentElement)
  const value = styles.getPropertyValue(token).trim()
  return value || FALLBACKS[token]
}

export function chartInk(level: 'ink' | 'muted' | 'dim' = 'muted'): string {
  if (typeof window === 'undefined') {
    return level === 'ink' ? 'oklch(0.95 0.012 70)' : 'oklch(0.7 0.018 70)'
  }
  const styles = getComputedStyle(document.documentElement)
  const lAxis = styles.getPropertyValue(
    level === 'ink' ? '--ink-l' : level === 'muted' ? '--ink-muted-l' : '--ink-dim-l',
  )
  const c = styles.getPropertyValue('--ink-c').trim() || '0.012'
  const h = styles.getPropertyValue('--ink-h').trim() || '70'
  return `oklch(${lAxis.trim() || '0.7'} ${c} ${h})`
}

export function chartLine(): string {
  if (typeof window === 'undefined') return 'oklch(0.32 0.012 70)'
  const styles = getComputedStyle(document.documentElement)
  const l = styles.getPropertyValue('--line-l').trim() || '0.32'
  const c = styles.getPropertyValue('--line-c').trim() || '0.012'
  const h = styles.getPropertyValue('--line-h').trim() || '70'
  return `oklch(${l} ${c} ${h})`
}
