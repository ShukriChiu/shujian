import type { Spec } from '@json-render/core'

/**
 * A single rendered artifact in the workspace's right pane. Produced by
 * `useCursorChat` whenever a Cursor `tool_call` reaches `completed`.
 *
 * `kind` is an open string — older code used a closed business-domain
 * union (`'revenue' | 'refund' | …`), but the dashboard pane doesn't
 * branch on it; it only matters for analytics / future filtering.
 */
export interface ArtifactBundle {
  id: string
  kind: string
  title: string
  summary: string
  /** Markdown context attached to the artifact (optional). */
  narrative?: string
  spec: Spec
}
