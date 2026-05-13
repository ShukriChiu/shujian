/**
 * UI-side type re-exports + lookup tables for `apps/future`.
 *
 * The wire types (`Student`, `Project`, `Squad`, `Feedback`, `WarRoomData`)
 * live in `@shujian/shared-types` so the Rust backend (`apps/backend/src/
 * handlers/future.rs`) and this React app stay aligned. Keep that file
 * the source of truth.
 *
 * The `*_META` records below are presentation-only — colors, tone tags,
 * Chinese labels — and never go over the wire.
 */

import type {
  Background,
  Feedback as SharedFeedback,
  FeedbackSignal,
  FutureWarRoomData,
  Project as SharedProject,
  ProjectSource,
  ProjectStatus,
  SkillKey,
  Squad as SharedSquad,
  Student as SharedStudent,
  StudentStatus,
} from '@shujian/shared-types'

export type {
  Background,
  FeedbackSignal,
  ProjectSource,
  ProjectStatus,
  SkillKey,
  StudentStatus,
}

export type Student = SharedStudent
export type Project = SharedProject
export type Squad = SharedSquad
export type Feedback = SharedFeedback
export type WarRoomData = FutureWarRoomData

export const SKILL_META: Record<SkillKey, { label: string; hue: number }> = {
  frontend: { label: '前端', hue: 195 },
  backend: { label: '后端', hue: 265 },
  design: { label: '设计', hue: 25 },
  product: { label: '产品', hue: 55 },
  research: { label: '研究', hue: 145 },
  data: { label: '数据', hue: 305 },
  comms: { label: '沟通', hue: 5 },
}

export const BACKGROUND_HUE: Record<Background, number> = {
  产品设计: 25,
  计算机: 200,
  生医工程: 145,
  商科: 60,
  人文社科: 305,
  其他: 240,
}

export const STUDENT_STATUS_META: Record<
  StudentStatus,
  { label: string; tone: 'amber' | 'gold' | 'mute' | 'fade' }
> = {
  active: { label: '可上项目', tone: 'amber' },
  spotlight: { label: '重点培养', tone: 'gold' },
  pending: { label: '待面谈', tone: 'mute' },
  paused: { label: '暂缓', tone: 'fade' },
}

export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { label: string; tone: 'amber' | 'teal' | 'mute' | 'gold' }
> = {
  recruiting: { label: '招募中', tone: 'amber' },
  sailing: { label: '航行中', tone: 'teal' },
  docked: { label: '靠港中', tone: 'mute' },
  shipped: { label: '已交付', tone: 'gold' },
}

export const SIGNAL_META: Record<
  FeedbackSignal,
  { label: string; tone: 'teal' | 'amber' | 'gold' | 'coral' }
> = {
  shipping: { label: '执行稳定', tone: 'teal' },
  learning: { label: '学习快', tone: 'amber' },
  breakthrough: { label: '突破时刻', tone: 'gold' },
  needs_followup: { label: '需要跟进', tone: 'coral' },
}
