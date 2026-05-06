import { cn } from '@/lib/utils'

/**
 * Single-stroke sparkline. SVG only. Uses currentColor so callers can
 * recolor via a wrapping `text-accent` etc.
 */
export function Sparkline({
  values,
  width = 64,
  height = 18,
  className,
  strokeWidth = 1.4,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
  strokeWidth?: number
}) {
  if (values.length === 0) {
    return (
      <svg width={width} height={height} className={cn('text-ink-dim', className)} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeDasharray="2 3"
          strokeWidth={1}
        />
      </svg>
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : 0
  const path = values
    .map((v, i) => {
      const x = i * step
      const y = height - 2 - ((v - min) / span) * (height - 4)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className={cn('text-accent', className)} aria-hidden>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
