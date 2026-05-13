/**
 * Types describing the contract between `apps/backend` (Rust + Axum) and
 * `apps/future` (React + Vite) for the AI 学生实战人才池管理台.
 *
 * Keep these in sync with:
 *  - apps/backend/src/handlers/future.rs   (Rust DTOs, camelCase serde)
 *  - apps/backend/migrations/0005_*.sql    (CHECK constraints define the unions)
 *
 * Per-app convention:
 *  - Tables: `future_*` prefix.
 *  - HTTP route: `/v1/future/*`.
 *  - Types: this file. Frontend imports as `import type { ... } from "@shujian/shared-types"`.
 */

export type SkillKey =
  | "frontend"
  | "backend"
  | "design"
  | "product"
  | "research"
  | "data"
  | "comms";

export type Background =
  | "产品设计"
  | "计算机"
  | "生医工程"
  | "商科"
  | "人文社科"
  | "其他";

export type StudentStatus = "active" | "spotlight" | "pending" | "paused";

export type ProjectStatus = "recruiting" | "sailing" | "docked" | "shipped";

export type ProjectSource =
  | "友联"
  | "三诺"
  | "趣学洋葱"
  | "个人实验室"
  | "外部合作";

export type FeedbackSignal =
  | "shipping"
  | "learning"
  | "breakthrough"
  | "needs_followup";

export interface Student {
  id: string;
  name: string;
  alias?: string;
  initial: string;
  background: Background;
  school: string;
  major: string;
  grade: string;
  skills: Partial<Record<SkillKey, number>>;
  availability: string;
  status: StudentStatus;
  intro: string;
  joinedAt: string;
}

export interface Project {
  id: string;
  name: string;
  codename: string;
  source: ProjectSource;
  difficulty: 1 | 2 | 3;
  skillNeeds: Partial<Record<SkillKey, number>>;
  teamSize: number;
  status: ProjectStatus;
  brief: string;
  nextMilestone: string;
  startedAt: string;
}

export interface Squad {
  studentId: string;
  projectId: string;
  role: string;
  joinedAt: string;
}

export interface Feedback {
  id: string;
  studentId: string;
  projectId?: string;
  date: string;
  signal: FeedbackSignal;
  notes: string;
}

export interface FutureWarRoomData {
  students: Student[];
  projects: Project[];
  squads: Squad[];
  feedback: Feedback[];
}
