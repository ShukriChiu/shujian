import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Panel({
  title,
  sub,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string
  sub?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('panel', className)}>
      <header className="panel-header">
        <div>
          <div className="panel-title">{title}</div>
          {sub && <div className="panel-sub mt-0.5">{sub}</div>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  )
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <div className="text-sm font-medium text-ink-700">{title}</div>
      {hint && <div className="max-w-[36ch] text-xs text-ink-500">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorBanner({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="m-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <div className="font-medium">请求失败</div>
      <div className="mt-0.5 break-all">{message}</div>
    </div>
  )
}
