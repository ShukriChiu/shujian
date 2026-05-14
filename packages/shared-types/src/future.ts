/**
 * Wire types for `apps/future` — student intake CRM.
 *
 * Mirrors `apps/backend/src/handlers/future/*` (camelCase via serde
 * `rename_all`). Source of truth for both producer and consumer; ensure
 * any rename here lands in the same commit as the matching Rust struct.
 */

// ─── Enums ────────────────────────────────────────────────────────────

export type FutureGradeYear =
  | 'freshman'
  | 'sophomore'
  | 'junior'
  | 'senior'
  | 'master_1'
  | 'master_2'
  | 'master_3'
  | 'phd'
  | 'alumni'
  | 'other'

export type FutureStudentStatus =
  | 'new'
  | 'reviewing'
  | 'interview'
  | 'accepted'
  | 'rejected'
  | 'in_project'
  | 'alumni'
  | 'archived'

export type FutureProjectStatus =
  | 'planning'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived'

export type FutureAssignmentStatus = 'active' | 'completed' | 'left'

export type FutureNoteKind =
  | 'general'
  | 'intake'
  | 'interview'
  | 'checkin'
  | 'milestone'
  | 'concern'

// ─── Public surface (apply page) ──────────────────────────────────────

export interface FuturePublicTenantInfo {
  tenantName: string
  label: string
  isOpen: boolean
}

export interface FutureApplyPayload {
  fullName: string
  wechatId: string
  phone: string
  birthYear: number
  university?: string
  major?: string
  gradeYear?: FutureGradeYear
  aiUnderstanding?: string
  aiExperience?: string
  pastProjects?: string
  /** 问卷文案为「一些个人目标」；仍映射到服务端 motivation 字段 */
  motivation?: string
}

export interface FutureApplyResult {
  studentId: string
}

// ─── Admin surface ────────────────────────────────────────────────────

export interface FutureStudentSummary {
  id: string
  fullName: string
  /** 出生年份（公历），新表单必填；历史数据可能为空 */
  birthYear: number | null
  wechatNickname: string
  university: string
  major: string
  gradeYear: FutureGradeYear
  status: FutureStudentStatus
  tags: string[]
  hasResume: boolean
  /** ISO-8601 timestamp */
  submittedAt: string
  /** ISO-8601 timestamp */
  updatedAt: string
}

export interface FutureStudentDetail extends FutureStudentSummary {
  wechatId: string
  email: string
  phone: string
  aiUnderstanding: string
  aiExperience: string
  pastProjects: string
  motivation: string
  adminNotes: string
  /** ISO-8601 timestamp; null until first admin action moves status off "new" */
  reviewedAt: string | null
}

/**
 * Partial-update payload. `undefined` preserves the field; a value
 * overwrites. Pass `tags: []` to clear tags.
 */
export interface FutureUpdateStudent {
  fullName?: string
  wechatId?: string
  wechatNickname?: string
  email?: string
  phone?: string
  birthYear?: number
  university?: string
  major?: string
  gradeYear?: FutureGradeYear
  aiUnderstanding?: string
  aiExperience?: string
  pastProjects?: string
  motivation?: string
  status?: FutureStudentStatus
  adminNotes?: string
  tags?: string[]
}

export interface FutureProject {
  id: string
  name: string
  summary: string
  status: FutureProjectStatus
  /** ISO-8601 date YYYY-MM-DD */
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
  activeMemberCount: number
}

export interface FutureCreateProject {
  name: string
  summary?: string
  status?: FutureProjectStatus
  startedAt?: string
  endedAt?: string
}

export interface FutureUpdateProject {
  name?: string
  summary?: string
  status?: FutureProjectStatus
  startedAt?: string | null
  endedAt?: string | null
}

export interface FutureAssignment {
  studentId: string
  projectId: string
  studentName: string
  projectName: string
  role: string
  status: FutureAssignmentStatus
  /** ISO-8601 date */
  joinedAt: string
  leftAt: string | null
  notes: string
  updatedAt: string
}

export interface FutureCreateAssignment {
  projectId: string
  role?: string
  status?: FutureAssignmentStatus
  joinedAt?: string
  notes?: string
}

export interface FutureUpdateAssignment {
  role?: string
  status?: FutureAssignmentStatus
  joinedAt?: string
  leftAt?: string | null
  notes?: string
}

export interface FutureNote {
  id: string
  studentId: string
  projectId: string | null
  projectName: string | null
  kind: FutureNoteKind
  body: string
  authorUserId: string | null
  authorName: string | null
  createdAt: string
}

export interface FutureCreateNote {
  body: string
  kind?: FutureNoteKind
  projectId?: string
}

export interface FutureShareLink {
  token: string
  label: string
  isOpen: boolean
}

export interface FutureUpdateShareLink {
  label?: string
  isOpen?: boolean
}
