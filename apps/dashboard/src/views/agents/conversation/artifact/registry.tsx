import { memo, useMemo } from 'react'
import { JSONUIProvider, Renderer, defineRegistry, flatToTree } from '@json-render/react'
import type { Spec } from '@json-render/core'
import { businessCatalog } from './catalog'
import {
  BarChart,
  Callout,
  DataTable,
  Frame,
  Heading,
  LineChart,
  Metric,
  PieChart,
  Stack,
  Text,
} from './components'

/**
 * Bind catalog → React components. Each renderer gets `props` (validated by
 * the catalog's Zod schema) and an optional `children` slot if the catalog
 * declared `slots: ['default']`.
 *
 * Drill-down + export actions stay no-ops until we wire them through the
 * agent. They live in the catalog so the prompt knows about them.
 */
export const { registry } = defineRegistry(businessCatalog, {
  components: {
    Frame: ({ props, children }) => <Frame props={props as never}>{children}</Frame>,
    Stack: ({ props, children }) => <Stack props={props as never}>{children}</Stack>,
    Heading: ({ props }) => <Heading props={props as never} />,
    Text: ({ props }) => <Text props={props as never} />,
    Metric: ({ props }) => <Metric props={props as never} />,
    LineChart: ({ props }) => <LineChart props={props as never} />,
    BarChart: ({ props }) => <BarChart props={props as never} />,
    PieChart: ({ props }) => <PieChart props={props as never} />,
    DataTable: ({ props }) => <DataTable props={props as never} />,
    Callout: ({ props, children }) => <Callout props={props as never}>{children}</Callout>,
  },
  actions: {
    drill_down: async () => ({ ok: true }),
    export_artifact: async () => ({ ok: true }),
  },
})

/**
 * Convenience renderer that accepts a flat or nested spec and shows a
 * skeleton when no spec has arrived yet.
 */
export const ArtifactRenderer = memo(function ArtifactRenderer({
  spec,
}: {
  spec: Spec | null | undefined
}) {
  // The Renderer expects a flat spec ({ root, elements }). If we got nested
  // JSON (which is friendlier for hand-written mocks) we flatten via
  // flatToTree's reverse — but recharts-friendly: build flat upfront.
  const safeSpec = useMemo(() => spec ?? null, [spec])
  if (!safeSpec) return <ArtifactSkeleton />
  // JSONUIProvider supplies the Visibility/State/Validation/Action contexts
  // that <Renderer> (and hooks like useVisibility) require.
  return (
    <JSONUIProvider registry={registry}>
      <Renderer spec={safeSpec} registry={registry} loading={<ArtifactSkeleton />} />
    </JSONUIProvider>
  )
}, (a, b) => a.spec === b.spec)

export { flatToTree }

function ArtifactSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex items-center gap-2">
        <div className="h-3 w-32 animate-pulse rounded bg-surface-3" />
        <div className="h-3 w-12 animate-pulse rounded bg-surface-3/60" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex h-[88px] flex-col justify-between rounded-lg border border-line bg-surface-2 p-4"
          >
            <div className="h-2.5 w-20 animate-pulse rounded bg-surface-3" />
            <div className="h-5 w-24 animate-pulse rounded bg-surface-3" />
            <div className="h-2 w-16 animate-pulse rounded bg-surface-3/60" />
          </div>
        ))}
      </div>
      <div className="h-[240px] animate-pulse rounded-lg border border-line bg-surface-2/60" />
    </div>
  )
}
