import { cn } from '@/lib/utils'

/**
 * Empty-state primitive — single line title + monospace hint + at most one
 * primary CTA. No vector blob illustrations. The console aesthetic.
 */
export function EmptyState({
  title,
  hint,
  action,
  glyph,
  className,
}: {
  title: string
  hint?: React.ReactNode
  action?: React.ReactNode
  glyph?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line px-6 py-16 text-center',
        className,
      )}
    >
      {glyph && (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-ink-dim">
          {glyph}
        </div>
      )}
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && (
        <div className="max-w-prose font-mono text-[11px] leading-relaxed text-ink-dim">
          {hint}
        </div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
