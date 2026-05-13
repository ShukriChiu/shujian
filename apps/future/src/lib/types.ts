/**
 * UI re-exports + presentation lookup tables for `apps/future`.
 *
 * The wire types live in `@shujian/shared-types`; this file is purely a
 * convenience re-export plus enum→{label, tone} maps that are
 * presentation-only and never go over the wire.
 */

import type {
  FutureAssignmentStatus,
  FutureGradeYear,
  FutureNoteKind,
  FutureProjectStatus,
  FutureStudentStatus,
} from '@shujian/shared-types'

export type {
  FutureApplyPayload,
  FutureApplyResult,
  FutureAssignment,
  FutureAssignmentStatus,
  FutureCreateAssignment,
  FutureCreateNote,
  FutureCreateProject,
  FutureGradeYear,
  FutureNote,
  FutureNoteKind,
  FutureProject,
  FutureProjectStatus,
  FuturePublicTenantInfo,
  FutureShareLink,
  FutureStudentDetail,
  FutureStudentStatus,
  FutureStudentSummary,
  FutureUpdateAssignment,
  FutureUpdateProject,
  FutureUpdateShareLink,
  FutureUpdateStudent,
} from '@shujian/shared-types'

// ─── Tone palette ─────────────────────────────────────────────────────
// Matches index.css design tokens. Keep these names lined up with the
// `tone` keys we render via `getToneStyles()`.

export type Tone =
  | 'amber'
  | 'gold'
  | 'mute'
  | 'teal'
  | 'indigo'
  | 'fade'
  | 'coral'

export function getToneStyles(tone: Tone): {
  bg: string
  fg: string
  border: string
} {
  switch (tone) {
    case 'amber':
      return {
        bg: 'var(--vermilion-soft)',
        fg: 'var(--vermilion-deep)',
        border: 'var(--vermilion-soft)',
      }
    case 'gold':
      return {
        bg: 'var(--gold-soft)',
        fg: 'oklch(45% 0.13 78)',
        border: 'var(--gold-soft)',
      }
    case 'teal':
      return {
        bg: 'var(--moss-soft)',
        fg: 'var(--moss)',
        border: 'var(--moss-soft)',
      }
    case 'indigo':
      return {
        bg: 'var(--indigo-soft)',
        fg: 'var(--indigo)',
        border: 'var(--indigo-soft)',
      }
    case 'coral':
      return {
        bg: 'var(--vermilion-soft)',
        fg: 'var(--vermilion-deep)',
        border: 'var(--vermilion-soft)',
      }
    case 'mute':
      return {
        bg: 'var(--inset)',
        fg: 'var(--ink-soft)',
        border: 'var(--hairline)',
      }
    case 'fade':
      return {
        bg: 'transparent',
        fg: 'var(--faint)',
        border: 'var(--hairline-soft)',
      }
  }
}

// ─── Enum metadata ────────────────────────────────────────────────────

export const STUDENT_STATUS_META: Record<
  FutureStudentStatus,
  { label: string; tone: Tone }
> = {
  new: { label: '新申请', tone: 'amber' },
  reviewing: { label: '审核中', tone: 'gold' },
  interview: { label: '安排面谈', tone: 'indigo' },
  accepted: { label: '已通过', tone: 'teal' },
  rejected: { label: '已拒绝', tone: 'fade' },
  in_project: { label: '在项目中', tone: 'gold' },
  alumni: { label: '已毕业', tone: 'mute' },
  archived: { label: '已归档', tone: 'fade' },
}

export const STUDENT_STATUS_ORDER: FutureStudentStatus[] = [
  'new',
  'reviewing',
  'interview',
  'accepted',
  'in_project',
  'rejected',
  'alumni',
  'archived',
]

export const GRADE_YEAR_META: Record<FutureGradeYear, string> = {
  freshman: '大一',
  sophomore: '大二',
  junior: '大三',
  senior: '大四',
  master_1: '研一',
  master_2: '研二',
  master_3: '研三',
  phd: '博士',
  alumni: '已毕业',
  other: '其他',
}

export const GRADE_YEAR_ORDER: FutureGradeYear[] = [
  'freshman',
  'sophomore',
  'junior',
  'senior',
  'master_1',
  'master_2',
  'master_3',
  'phd',
  'alumni',
  'other',
]

export const PROJECT_STATUS_META: Record<
  FutureProjectStatus,
  { label: string; tone: Tone }
> = {
  planning: { label: '筹备中', tone: 'mute' },
  active: { label: '进行中', tone: 'amber' },
  paused: { label: '已暂停', tone: 'fade' },
  completed: { label: '已完成', tone: 'teal' },
  archived: { label: '已归档', tone: 'fade' },
}

export const ASSIGNMENT_STATUS_META: Record<
  FutureAssignmentStatus,
  { label: string; tone: Tone }
> = {
  active: { label: '在岗', tone: 'amber' },
  completed: { label: '完成', tone: 'teal' },
  left: { label: '离开', tone: 'fade' },
}

export const NOTE_KIND_META: Record<
  FutureNoteKind,
  { label: string; tone: Tone }
> = {
  general: { label: '一般备注', tone: 'mute' },
  intake: { label: '入池', tone: 'amber' },
  interview: { label: '面谈', tone: 'indigo' },
  checkin: { label: '复盘', tone: 'teal' },
  milestone: { label: '里程碑', tone: 'gold' },
  concern: { label: '需关注', tone: 'coral' },
}
