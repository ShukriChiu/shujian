import { useDroppable } from '@dnd-kit/core'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronRight, Pencil } from 'lucide-react'
import {
  PROJECT_STATUS_META,
  SKILL_META,
  type Project,
  type SkillKey,
  type Student,
} from '../lib/types'
import { StudentChip } from './student-chip'
import { SquadPortrait } from './squad-portrait'

type Props = {
  project: Project
  index: number
  members: Student[]
  isFocused: boolean
  onOpen: (id: string) => void
  onEdit: (project: Project) => void
  onSelectStudent: (s: Student) => void
}

export function ProjectLane({
  project,
  index,
  members,
  isFocused,
  onOpen,
  onEdit,
  onSelectStudent,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: `lane-${project.id}`,
    data: { projectId: project.id, kind: 'lane' },
  })

  const status = PROJECT_STATUS_META[project.status]
  const slots = Array.from({ length: project.teamSize }, (_, i) => members[i] ?? null)

  return (
    <motion.article
      ref={setNodeRef}
      layout
      style={{ viewTransitionName: `lane-${project.id}` } as React.CSSProperties}
      className={`folio folio-${status.tone} ${isOver ? 'is-over' : ''} ${
        isFocused ? 'is-focused' : ''
      }`}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
    >
      <div className="folio-spine" aria-hidden>
        <span className="folio-spine-num mono">
          卷 {String(index + 1).padStart(2, '0')}
        </span>
        <span className="folio-spine-line" />
        <span className="folio-spine-source">{project.source}</span>
      </div>

      <div className="folio-body">
        <header className="folio-head">
          <div className="folio-head-row">
            <span className={`status-seal status-seal-${status.tone}`}>
              {status.label}
            </span>
            <span className="folio-codename mono">{project.codename}</span>
            <Difficulty value={project.difficulty} />
            <button
              type="button"
              className="folio-edit"
              onClick={() => onEdit(project)}
              aria-label="编辑项目"
            >
              <Pencil size={12} />
            </button>
          </div>
          <button
            type="button"
            className="folio-title-button"
            onClick={() => onOpen(project.id)}
          >
            <h3 className="folio-title serif">{project.name}</h3>
            <ChevronRight size={20} className="folio-title-arrow" />
          </button>
          <p className="folio-brief">{project.brief}</p>
        </header>

        <div className="folio-needs">
          <span className="eyebrow">所需能力</span>
          <div className="folio-needs-list">
            {(Object.entries(project.skillNeeds) as Array<[SkillKey, number]>).map(
              ([skill, weight]) => (
                <span
                  key={skill}
                  className="need-tag"
                  style={{ ['--hue' as string]: SKILL_META[skill].hue }}
                >
                  <span className="serif">{SKILL_META[skill].label}</span>
                  <span className="need-weight mono">{weight}</span>
                </span>
              ),
            )}
          </div>
        </div>

        <div className="folio-roster">
          <div className="folio-roster-head">
            <span className="eyebrow">小队成员 · {members.length} / {project.teamSize}</span>
            {members.length === 0 && (
              <span className="folio-roster-hint">把右侧学籍簿里的学生拖过来</span>
            )}
          </div>
          <div className="folio-slots">
            {slots.map((member, i) => (
              <SlotCell
                key={i}
                index={i}
                member={member}
                laneId={project.id}
                onSelect={onSelectStudent}
              />
            ))}
          </div>
        </div>

        <AnimatePresence>
          {members.length > 0 && (
            <SquadPortrait key="portrait" project={project} members={members} variant="inline" />
          )}
        </AnimatePresence>

        <footer className="folio-foot">
          <p className="folio-milestone">
            <span className="eyebrow">下一里程碑</span>
            <span className="serif folio-milestone-text">
              {project.nextMilestone || '尚未设定'}
            </span>
          </p>
          <button
            type="button"
            className="folio-open"
            onClick={() => onOpen(project.id)}
          >
            翻开内页 <ChevronRight size={14} />
          </button>
        </footer>
      </div>
    </motion.article>
  )
}

function SlotCell({
  member,
  laneId,
  index,
  onSelect,
}: {
  member: Student | null
  laneId: string
  index: number
  onSelect: (s: Student) => void
}) {
  return (
    <div className={`slot ${member ? 'is-filled' : 'is-empty'}`}>
      {member ? (
        <StudentChip
          student={member}
          origin="lane"
          laneId={laneId}
          variant="card"
          onSelect={onSelect}
        />
      ) : (
        <>
          <span className="slot-number mono">{String(index + 1).padStart(2, '0')}</span>
          <span className="slot-empty-line" />
          <span className="slot-empty-hint">空缺</span>
        </>
      )}
    </div>
  )
}

function Difficulty({ value }: { value: 1 | 2 | 3 }) {
  return (
    <span className="difficulty" aria-label={`难度 ${value}/3`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`difficulty-tick ${n <= value ? 'on' : ''}`}
          aria-hidden
        />
      ))}
    </span>
  )
}

export function NewLaneCard({ onCreate }: { onCreate: () => void }) {
  return (
    <button type="button" className="folio-new" onClick={onCreate}>
      <span className="folio-new-mark">＋</span>
      <span className="folio-new-text serif">新建项目卷宗</span>
      <span className="folio-new-sub eyebrow">NEW VOLUME</span>
    </button>
  )
}
