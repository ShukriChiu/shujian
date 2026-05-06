import { useEffect, useMemo, useRef } from 'react'
import { Cpu, FolderOpen, Wand2, Zap } from 'lucide-react'
import type { CursorSkill } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface SkillPickerProps {
  open: boolean
  query: string
  skills: CursorSkill[]
  highlight: number
  setHighlight: (n: number) => void
  onPick: (skill: CursorSkill) => void
  onClose: () => void
}

/**
 * Detect if we should pop the slash menu given the current textarea state.
 * Returns the active query (text after the slash) or null if no slash context.
 */
export function detectSlashContext(text: string, caret: number): string | null {
  if (caret === 0) return null
  // walk back from caret-1 to find the last `/`. If we hit a space / newline
  // before the slash, abort (we only trigger at start-of-line slash).
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '/') {
      const before = i === 0 ? '\n' : text[i - 1]
      if (before === '\n' || before === undefined) {
        return text.slice(i + 1, caret)
      }
      return null
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return null
  }
  return null
}

export function filterSkills(skills: CursorSkill[], query: string): CursorSkill[] {
  if (!query) return skills
  const q = query.toLowerCase()
  // prefix match first, then contains
  const prefix: CursorSkill[] = []
  const contains: CursorSkill[] = []
  for (const s of skills) {
    const name = s.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(s)
    else if (name.includes(q) || s.description.toLowerCase().includes(q)) contains.push(s)
  }
  return [...prefix, ...contains].slice(0, 8)
}

export function SkillPicker({
  open,
  query,
  skills,
  highlight,
  setHighlight,
  onPick,
  onClose,
}: SkillPickerProps) {
  const filtered = useMemo(() => filterSkills(skills, query), [skills, query])
  const listRef = useRef<HTMLDivElement | null>(null)

  // clamp highlight when list changes
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0)
  }, [filtered.length, highlight, setHighlight])

  // scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  // close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const root = listRef.current
      if (root && !root.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1.5 shadow-[0_-4px_24px_-6px_rgba(15,23,42,0.18)] scroll-thin"
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        <Wand2 className="h-3 w-3" />
        Skills · /{query || '…'}
        <span className="ml-auto font-mono text-ink-400">{filtered.length}</span>
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-3 text-xs text-ink-500">
          没有匹配的 skill。检查 <code>~/.cursor/skills-cursor/</code> 或当前 cwd 的{' '}
          <code>.cursor/skills/</code>。
        </div>
      ) : (
        filtered.map((s, i) => (
          <button
            key={s.path}
            data-idx={i}
            onMouseDown={(e) => {
              // mousedown fires before blur so the textarea keeps focus
              e.preventDefault()
              onPick(s)
            }}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition',
              i === highlight ? 'bg-violet-50' : 'hover:bg-ink-50',
            )}
          >
            <div
              className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded',
                s.source === 'project' ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700',
              )}
            >
              {s.source === 'project' ? <FolderOpen className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] font-semibold text-ink-900">/{s.name}</span>
                <span
                  className={cn(
                    'pill text-[9px]',
                    s.source === 'project' ? 'pill-ok' : 'pill-accent',
                  )}
                >
                  {s.source}
                </span>
              </div>
              {s.description && (
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-500">
                  {s.description}
                </div>
              )}
            </div>
            {i === highlight && (
              <Zap className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" />
            )}
          </button>
        ))
      )}
      <div className="mt-1 flex items-center gap-2 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-400">
        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">↑↓</span>
        <span>选</span>
        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">Tab/Enter</span>
        <span>插入</span>
        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono">Esc</span>
        <span>取消</span>
      </div>
    </div>
  )
}
