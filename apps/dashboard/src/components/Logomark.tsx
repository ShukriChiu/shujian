import { cn } from '@/lib/utils'

/**
 * Register logomark — a "circular pulse" glyph.
 *
 * A 24px square with two concentric arcs and a single solid dot in the
 * center. The outer arc is broken at the right (open ring) which reads as
 * "control plane: incoming + outgoing." Pure SVG, accent-colored.
 */
export function Logomark({
  className,
  size = 24,
  pulse = false,
}: {
  className?: string
  size?: number
  pulse?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 text-accent', className)}
      aria-hidden="true"
    >
      {/* outer broken ring */}
      <path
        d="M21 12a9 9 0 1 1-3.6-7.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.92"
      />
      {/* inner ring */}
      <circle cx="12" cy="12" r="5.5" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      {/* core dot */}
      <circle cx="12" cy="12" r="2.1" fill="currentColor" className={pulse ? 'animate-pulse-dot' : ''} />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Logomark size={18} pulse />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Register</span>
    </span>
  )
}
