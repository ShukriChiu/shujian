import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, Download, Maximize2, Minimize2, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ArtifactRenderer } from '@/views/agents/conversation/artifact/registry'
import type { ArtifactBundle } from '@/views/agents/conversation/artifact/mock-data'

interface Props {
  artifacts: ArtifactBundle[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}

/**
 * Anthropic-Artifacts inspired canvas: tabs of charts/dashboards live
 * here, the chat stays focused on conversation. A full-screen toggle
 * promotes the active artifact to take the whole workspace.
 */
export function ArtifactPane({ artifacts, activeId, onSelect, onClose }: Props) {
  const [maximized, setMaximized] = useState(false)
  const tabBarRef = useRef<HTMLDivElement>(null)

  const active = useMemo(
    () => artifacts.find((a) => a.id === activeId) ?? artifacts[artifacts.length - 1] ?? null,
    [artifacts, activeId],
  )

  // Auto-scroll active tab into view when a new artifact arrives.
  useEffect(() => {
    if (!tabBarRef.current || !active) return
    const tab = tabBarRef.current.querySelector<HTMLElement>(`[data-tab-id="${active.id}"]`)
    tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [active])

  if (artifacts.length === 0) {
    return <EmptyArtifactPane />
  }
  if (!active) return null

  return (
    <section
      className={cn(
        'flex h-full min-h-0 flex-col bg-bg',
        maximized && 'fixed inset-0 z-50 animate-fade-in bg-bg/95 backdrop-blur',
      )}
    >
      <div className="flex items-stretch border-b border-line">
        <div
          ref={tabBarRef}
          className="scroll-thin flex flex-1 items-stretch gap-0.5 overflow-x-auto px-2 pt-2"
        >
          {artifacts.map((a) => {
            const isActive = a.id === active.id
            return (
              <button
                key={a.id}
                data-tab-id={a.id}
                type="button"
                onClick={() => onSelect(a.id)}
                className={cn(
                  'group relative flex shrink-0 items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-[12px]',
                  'transition-colors duration-150 ease-out-quart',
                  isActive
                    ? 'border-accent bg-surface text-ink'
                    : 'border-transparent text-ink-muted hover:bg-surface/50 hover:text-ink',
                )}
              >
                <Sparkles
                  className={cn(
                    'h-3 w-3',
                    isActive ? 'text-accent' : 'text-ink-dim',
                  )}
                />
                <span className="max-w-[200px] truncate">{a.title}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(a.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      onClose(a.id)
                    }
                  }}
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-sm text-ink-dim',
                    'opacity-0 transition-opacity duration-150 hover:bg-surface-3 hover:text-ink group-hover:opacity-100',
                    isActive && 'opacity-60',
                  )}
                  aria-label="close artifact"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1 px-2">
          <ToolbarButton
            label="export"
            icon={<Download className="h-3.5 w-3.5" />}
            onClick={() => exportMarkdown(active)}
          />
          <ToolbarButton
            label={maximized ? 'restore' : 'maximize'}
            icon={
              maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />
            }
            onClick={() => setMaximized((v) => !v)}
          />
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          key={active.id}
          className="scroll-thin h-full animate-block-in overflow-hidden p-4"
        >
          <ArtifactRenderer spec={active.spec} />
        </div>
      </div>
    </section>
  )
}

function ToolbarButton({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-mono uppercase tracking-[0.06em] text-ink-dim hover:bg-surface-2 hover:text-ink"
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function EmptyArtifactPane() {
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center bg-bg px-8 py-12 text-center">
      <div className="relative mb-5">
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-accent/10 blur-2xl" />
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface">
          <Database className="h-6 w-6 text-accent" />
        </div>
      </div>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
        画布等你提问
      </h2>
      <p className="mt-2 max-w-md text-[12.5px] leading-[1.6] text-ink-muted">
        在左侧问任何关于业务的问题，我会从 vaults 取数、生成图表，并在这里铺开。
        每个回答都是一张可继续追问的画布。
      </p>
      <div className="mt-6 flex flex-col items-start gap-1.5 text-[11.5px] text-ink-dim">
        <CueLine label="Q3 营收情况" hint="→ 多指标 + 营收/退款双线" />
        <CueLine label="退款主要原因" hint="→ 横向条形 + 高退款班次表" />
        <CueLine label="未消课时风险" hint="→ 堆叠柱状 + 班次负债表" />
        <CueLine label="员工绩效" hint="→ KPI 表 + 续费/退款双柱" />
      </div>
    </section>
  )
}

function CueLine({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-center gap-3 font-mono text-[11.5px]">
      <span className="text-ink">{label}</span>
      <span className="text-ink-dim">{hint}</span>
    </div>
  )
}

function exportMarkdown(bundle: ArtifactBundle) {
  // Browsers can't easily PNG-export an SVG-tree without dependencies, so we
  // emit a copy-pasteable markdown summary for now. PNG is a follow-up.
  const md = `# ${bundle.title}\n\n${bundle.summary}\n\n${bundle.narrative}\n`
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${bundle.id}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
