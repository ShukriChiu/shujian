import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { motion } from 'motion/react'
import {
  BACKGROUND_HUE,
  STUDENT_STATUS_META,
  type Student,
} from '../lib/types'

type Variant = 'card' | 'compact' | 'avatar'

type Props = {
  student: Student
  origin: 'roster' | 'lane'
  laneId?: string
  variant?: Variant
  onSelect?: (student: Student) => void
}

export function StudentChip({
  student,
  origin,
  laneId,
  variant = 'card',
  onSelect,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `chip-${student.id}-${origin}-${laneId ?? 'roster'}`,
    data: { studentId: student.id, fromLane: laneId ?? null },
  })

  const hue = BACKGROUND_HUE[student.background]
  const status = STUDENT_STATUS_META[student.status]

  return (
    <motion.button
      ref={setNodeRef}
      type="button"
      layoutId={`student-${student.id}`}
      onClick={(e) => {
        if (isDragging) return
        e.stopPropagation()
        onSelect?.(student)
      }}
      {...listeners}
      {...attributes}
      className={`chip chip-${variant} chip-status-${status.tone} ${
        isDragging ? 'is-dragging' : ''
      }`}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.4 : 1,
        ['--hue' as string]: hue,
      }}
      aria-label={`${student.name}（${student.background}·${student.major}）`}
    >
      {variant === 'avatar' ? (
        <Monogram student={student} hue={hue} size={36} />
      ) : (
        <ChipBody student={student} hue={hue} compact={variant === 'compact'} />
      )}
    </motion.button>
  )
}

function Monogram({
  student,
  hue,
  size,
}: {
  student: Student
  hue: number
  size: number
}) {
  return (
    <span
      className="monogram"
      style={{
        width: size,
        height: size,
        background: `oklch(94% 0.04 ${hue})`,
        color: `oklch(36% 0.13 ${hue})`,
      }}
    >
      <span className="monogram-text serif">{student.initial}</span>
    </span>
  )
}

function ChipBody({
  student,
  hue,
  compact,
}: {
  student: Student
  hue: number
  compact: boolean
}) {
  return (
    <>
      <span className="chip-stripe" />
      <Monogram student={student} hue={hue} size={compact ? 28 : 32} />
      <span className="chip-meta">
        <span className="chip-name serif">{student.name}</span>
        <span className="chip-sub mono">
          {student.background}
          {!compact && ` · ${student.grade.split('（')[0]}`}
        </span>
      </span>
      {student.status === 'spotlight' && <SpotlightSeal />}
    </>
  )
}

function SpotlightSeal() {
  return (
    <span className="seal seal-gold" aria-label="重点培养">
      重点
    </span>
  )
}
