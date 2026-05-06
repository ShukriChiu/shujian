export function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center text-xs text-ink-dim">
      <span className="inline-flex items-center gap-2">
        <span className="dot dot-running" aria-hidden />
        正在加载
      </span>
    </div>
  )
}
