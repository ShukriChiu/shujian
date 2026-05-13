import { useDroppable } from '@dnd-kit/core'
import { motion, AnimatePresence } from 'motion/react'
import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  BACKGROUND_HUE,
  type Background,
  type Student,
} from '../lib/types'
import { StudentChip } from './student-chip'

type Props = {
  students: Student[]
  unassignedIds: Set<string>
  onSelect: (s: Student) => void
  onAddStudent: () => void
}

export function StudentRoster({
  students,
  unassignedIds,
  onSelect,
  onAddStudent,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'roster',
    data: { kind: 'roster' },
  })

  const [filter, setFilter] = useState<Background | 'all'>('all')
  const [query, setQuery] = useState('')
  const [showAssigned, setShowAssigned] = useState(true)

  const backgrounds = useMemo(() => {
    const set = new Set<Background>()
    students.forEach((s) => set.add(s.background))
    return Array.from(set)
  }, [students])

  const visible = useMemo(() => {
    return students.filter((s) => {
      if (!showAssigned && !unassignedIds.has(s.id)) return false
      if (filter !== 'all' && s.background !== filter) return false
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        const hay = `${s.name} ${s.alias ?? ''} ${s.major} ${s.background} ${s.school}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [students, filter, query, showAssigned, unassignedIds])

  const grouped = useMemo(() => {
    const map = new Map<Background, Student[]>()
    visible.forEach((s) => {
      const arr = map.get(s.background) ?? []
      arr.push(s)
      map.set(s.background, arr)
    })
    return Array.from(map.entries())
  }, [visible])

  const totalUnassigned = students.filter((s) => unassignedIds.has(s.id)).length

  return (
    <aside
      ref={setNodeRef}
      className={`roster ${isOver ? 'is-over' : ''}`}
      aria-label="学籍簿"
    >
      <header className="roster-head">
        <div className="roster-title-row">
          <div>
            <p className="eyebrow">学籍簿 · ROSTER</p>
            <h2 className="roster-title serif">学生编队</h2>
          </div>
          <button type="button" className="roster-add" onClick={onAddStudent}>
            <Plus size={14} />
            <span className="serif">录入</span>
          </button>
        </div>
        <p className="roster-meta mono">
          <span>{students.length} 人在册</span>
          <span className="roster-dot">·</span>
          <span>{totalUnassigned} 人待派</span>
        </p>
      </header>

      <div className="roster-search">
        <Search size={13} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="姓名 / 专业 / 方向"
        />
      </div>

      <div className="roster-filters">
        <FilterTab
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          label="全部"
          count={students.length}
        />
        {backgrounds.map((bg) => (
          <FilterTab
            key={bg}
            active={filter === bg}
            onClick={() => setFilter(bg)}
            label={bg}
            count={students.filter((s) => s.background === bg).length}
            hue={BACKGROUND_HUE[bg]}
          />
        ))}
      </div>

      <label className="roster-toggle">
        <input
          type="checkbox"
          checked={showAssigned}
          onChange={(e) => setShowAssigned(e.target.checked)}
        />
        <span className="serif">显示已入队学生</span>
      </label>

      <div className="roster-clusters">
        <AnimatePresence>
          {grouped.length === 0 && (
            <motion.p
              key="empty"
              className="roster-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {students.length === 0 ? (
                <>
                  <span className="serif">学籍簿尚空</span>
                  <span className="mono">点上方"录入"开始</span>
                </>
              ) : (
                <span className="serif">没有匹配的学生</span>
              )}
            </motion.p>
          )}
          {grouped.map(([bg, arr]) => (
            <motion.div
              key={bg}
              layout
              className="roster-cluster"
              style={{ ['--hue' as string]: BACKGROUND_HUE[bg] }}
            >
              <div className="cluster-rule">
                <span className="cluster-rule-tick" />
                <span className="cluster-label serif">{bg}</span>
                <span className="cluster-rule-line" />
                <span className="cluster-count mono">{arr.length}</span>
              </div>
              <div className="cluster-chips">
                <AnimatePresence mode="popLayout">
                  {arr.map((s) => {
                    const isAssigned = !unassignedIds.has(s.id)
                    return (
                      <motion.div
                        key={s.id}
                        layout
                        initial={{ opacity: 0, scale: 0.9, y: 4 }}
                        animate={{
                          opacity: isAssigned ? 0.5 : 1,
                          scale: 1,
                          y: 0,
                        }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className={isAssigned ? 'is-assigned' : ''}
                      >
                        <StudentChip
                          student={s}
                          origin="roster"
                          variant="card"
                          onSelect={onSelect}
                        />
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </aside>
  )
}

function FilterTab({
  active,
  onClick,
  label,
  count,
  hue,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  hue?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`filter-tab ${active ? 'is-active' : ''}`}
      style={
        hue !== undefined
          ? ({ ['--hue' as string]: hue } as React.CSSProperties)
          : undefined
      }
    >
      <span className="serif filter-tab-label">{label}</span>
      <span className="mono filter-tab-count">{count}</span>
    </button>
  )
}
