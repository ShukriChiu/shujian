import type { CSSProperties } from 'react'
import { getToneStyles, type Tone } from '../lib/types'

interface StatusPillProps {
  tone: Tone
  label: string
  size?: 'sm' | 'md'
  style?: CSSProperties
}

/**
 * Compact status indicator. Used everywhere a status / kind / tag needs
 * a colored chip — student status, project status, note kind, etc.
 */
export function StatusPill({ tone, label, size = 'md', style }: StatusPillProps) {
  const tones = getToneStyles(tone)
  const dims =
    size === 'sm'
      ? { padding: '2px 8px', fontSize: 10.5, letterSpacing: '0.06em' }
      : { padding: '3px 10px', fontSize: 11.5, letterSpacing: '0.06em' }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: tones.bg,
        color: tones.fg,
        border: `1px solid ${tones.border}`,
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...dims,
        ...style,
      }}
    >
      {label}
    </span>
  )
}
