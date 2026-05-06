/**
 * Types describing the HTTP/SSE contract exposed by `apps/bridge`
 * (the @cursor/sdk wrapper) and consumed by `apps/dashboard` and `apps/agent`.
 *
 * Keep these in sync with `apps/bridge/src/server.ts`.
 */

export interface CursorAgentRunRequest {
  prompt: string;
  branch?: string;
  repo?: string;
}

export interface CursorAgentRunEvent {
  type: "started" | "delta" | "completed" | "error";
  runId: string;
  data?: unknown;
  error?: string;
}
