import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: string
  description?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-6', className)}>
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-[-0.012em] text-ink">{title}</h1>
          {meta && <div className="flex items-center gap-1.5 text-xs text-ink-dim">{meta}</div>}
        </div>
        {description && (
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  )
}
