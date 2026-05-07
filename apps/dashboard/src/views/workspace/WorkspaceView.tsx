import { useCallback, useEffect } from 'react'
import { ArtifactPane } from './ArtifactPane'
import { WorkspaceChat } from './WorkspaceChat'
import { useMockChat } from '@/views/agents/conversation/artifact/useMockChat'

/**
 * Anthropic-Artifacts inspired analytics workspace.
 *
 * Two columns:
 *   left  | streaming chat (mock agent that "queries vaults")
 *   right | tabbed artifact canvas, full-screenable
 *
 * For now this is a self-contained mock — when we wire the real
 * Cursor/agent backend, only `useMockChat` needs to swap out.
 */
export function WorkspaceView() {
  const chat = useMockChat()

  // Close any open artifact via Esc when the right pane is maximized.
  // (`ArtifactPane` owns its maximized state, so this is just a thin layer.)
  const onArtifactRequested = useCallback(() => {
    // no-op for now — the artifact pane animates in when chat.artifacts grows
  }, [])

  useEffect(() => {
    document.title = 'Workspace · Shujian'
  }, [])

  const handleClose = useCallback(
    (id: string) => {
      chat.removeArtifact(id)
    },
    [chat],
  )

  return (
    <div
      className="grid h-full min-h-0 w-full"
      style={{ gridTemplateColumns: 'minmax(380px, 0.45fr) minmax(0, 0.55fr)' }}
    >
      <div className="flex min-h-0 min-w-0 border-r border-line">
        <WorkspaceChat chat={chat} onArtifactRequested={onArtifactRequested} />
      </div>
      <div className="min-h-0 min-w-0">
        <ArtifactPane
          artifacts={chat.artifacts}
          activeId={chat.activeArtifactId}
          onSelect={chat.selectArtifact}
          onClose={handleClose}
        />
      </div>
    </div>
  )
}
