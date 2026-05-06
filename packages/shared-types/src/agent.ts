/**
 * Types describing the contract between the Rust agent daemon (`apps/agent`)
 * and any TypeScript consumer (`apps/dashboard`, `apps/bridge`).
 *
 * Keep these in sync with the Rust structs in `apps/agent/src/`.
 * Future: generate this file via `typeshare` from the Rust side.
 */

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AgentTaskSummary {
  id: string;
  agentType: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
}
