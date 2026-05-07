import type { Spec, UIElement } from '@json-render/core'

/**
 * Hand-writing flat specs is painful — they're great for streaming,
 * miserable for prototyping. This helper converts a nested tree to the
 * flat shape the renderer expects.
 *
 * Usage:
 *   const spec = buildSpec(
 *     node('Frame', { title: 'Q3' }, [
 *       node('Stack', { direction: 'horizontal' }, [
 *         node('Metric', { label: '总营收', value: 12_840_000, format: 'currency' }),
 *         node('Metric', { label: '退款率', value: 0.071, format: 'percent', invertTrend: true }),
 *       ]),
 *     ]),
 *   )
 */
export interface SpecNode {
  type: string
  props: Record<string, unknown>
  children?: SpecNode[]
  /** Stable key override; usually unnecessary. */
  key?: string
}

export function node(
  type: string,
  props: Record<string, unknown> = {},
  children: SpecNode[] = [],
): SpecNode {
  return { type, props, children }
}

export function buildSpec(root: SpecNode): Spec {
  const elements: Record<string, UIElement> = {}
  let counter = 0

  function visit(n: SpecNode, parentPath: string): string {
    const key = n.key ?? `${parentPath}/${n.type}-${counter++}`.toLowerCase()
    const childKeys = n.children?.map((c) => visit(c, key)) ?? []
    elements[key] = {
      type: n.type,
      props: n.props,
      children: childKeys.length ? childKeys : undefined,
    }
    return key
  }

  const rootKey = visit(root, 'r')
  return { root: rootKey, elements }
}
