/**
 * Canvas Protocol — agent's "json-render capability".
 *
 * Cursor cloud agents can't register custom tools, so we use a fenced-code
 * convention instead. The agent prints
 *
 *   ```canvas
 *   { "title": "Q3 营收", "kind": "metric", "value": 12450000, ... }
 *   ```
 *
 * inside its assistant turn, and the dashboard:
 *   1. extracts every closed ```canvas block from the streamed text,
 *   2. compiles the short schema into a json-render `Spec`,
 *   3. pushes it to the right pane as an `ArtifactBundle`,
 *   4. strips the JSON from the displayed text so the chat stays prose-only.
 *
 * Two flavours are supported:
 *   - shorthand: `kind ∈ metric | line | bar | pie | table | markdown | text`
 *     → adapter expands it into a `Frame > <Component>` spec.
 *   - escape hatch: `{ "title": "...", "spec": <full Spec> }`
 *     → forwarded as-is, useful for hand-written multi-element artifacts.
 *
 * Streaming-safe: only closed blocks (with the trailing ``` fence) are
 * ever returned. Mid-flight unclosed blocks stay buffered until the next
 * delta closes them.
 *
 * Documented for agents in `onion-knowledgebase/AGENTS.md` (Canvas Protocol).
 */

import type { Spec } from '@json-render/core'
import type { ArtifactBundle } from './types'

/* --------------------------- shorthand types ----------------------------- */

type ShortKind =
  | 'metric'
  | 'line'
  | 'bar'
  | 'pie'
  | 'table'
  | 'markdown'
  | 'text'

interface BlockBase {
  title: string
  subtitle?: string
  /** Period chip on the Frame (e.g. "Q3 2025"). */
  period?: string
}

interface MetricBlock extends BlockBase {
  kind: 'metric'
  value: number
  format?: 'number' | 'currency' | 'percent' | 'duration_h' | 'compact'
  currency?: string
  caption?: string
  delta?: number
  trend?: 'up' | 'down' | 'flat'
  invertTrend?: boolean
}

interface ChartPoint {
  x: string | number
  y: number
}
interface Series {
  name: string
  color?: string
  format?: MetricBlock['format']
  points: ChartPoint[]
}
interface ChartBlock extends BlockBase {
  kind: 'line' | 'bar' | 'pie'
  series: Series[]
  xLabel?: string
  yLabel?: string
}

interface TableColumn {
  header: string
  key: string
  format?: MetricBlock['format']
  align?: 'start' | 'center' | 'end'
  width?: number
}
interface TableBlock extends BlockBase {
  kind: 'table'
  columns: TableColumn[]
  rows: Array<Record<string, unknown>>
}

interface MarkdownBlock extends BlockBase {
  kind: 'markdown' | 'text'
  text: string
}

interface RawBlock {
  title: string
  subtitle?: string
  period?: string
  /** Full json-render Spec; used as-is. */
  spec: Spec
}

export type CanvasBlock =
  | MetricBlock
  | ChartBlock
  | TableBlock
  | MarkdownBlock
  | RawBlock

/* ------------------------------- extraction ----------------------------- */

export interface ExtractResult {
  /** Original text with every closed canvas block removed. */
  stripped: string
  /** Successfully parsed canvas blocks, in document order. */
  blocks: CanvasBlock[]
  /** Stable hashes of the raw block bodies — used for dedupe. */
  hashes: string[]
}

const FENCE_RE = /```canvas[ \t]*\n([\s\S]*?)\n```/g
/** Matches both closed and still-streaming (unclosed) canvas blocks.
 *  Used to hide the raw JSON from the chat surface even while the
 *  block is mid-flight — without it the user would briefly see the
 *  JSON spec until the closing fence arrives. */
const HIDE_RE = /```canvas\b[ \t]*\n[\s\S]*?(?:\n```|$)/g

/** Strip every ```canvas block (closed *or* in-progress) from `text`.
 *  Used by the chat surface to keep prose-only rendering. The
 *  artifact pane sees the source text via `extractCanvasBlocks`. */
export function hideCanvasInText(text: string): string {
  if (!text.includes('```canvas')) return text
  return text.replace(HIDE_RE, '').replace(/\n{3,}/g, '\n\n')
}

/** Pull every closed ```canvas block out of `text`. Open / unparseable
 *  blocks are silently left in `stripped` (they'll close on the next
 *  delta). Parse failures get logged and the block is left in place so
 *  the user at least sees the JSON instead of nothing. */
export function extractCanvasBlocks(text: string): ExtractResult {
  if (!text.includes('```canvas')) {
    return { stripped: text, blocks: [], hashes: [] }
  }
  const blocks: CanvasBlock[] = []
  const hashes: string[] = []
  let stripped = ''
  let lastEnd = 0
  for (const m of text.matchAll(FENCE_RE)) {
    const body = m[1] ?? ''
    const start = m.index ?? 0
    let parsed: CanvasBlock | null = null
    try {
      const json = JSON.parse(body) as unknown
      parsed = normalizeBlock(json)
    } catch {
      parsed = null
    }
    if (!parsed) {
      // Leave the original fenced block in the chat so the user can see
      // what the agent emitted rather than a silent disappearance.
      stripped += text.slice(lastEnd, start + m[0].length)
      lastEnd = start + m[0].length
      continue
    }
    stripped += text.slice(lastEnd, start)
    blocks.push(parsed)
    hashes.push(djb2(body.trim()))
    lastEnd = start + m[0].length
  }
  stripped += text.slice(lastEnd)
  // Collapse redundant blank lines we may have introduced when slicing
  // the fenced block out of a paragraph.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
  return { stripped, blocks, hashes }
}

/** Validate + coerce a parsed JSON value into a `CanvasBlock`. Returns
 *  null if the shape is unrecognised; the caller leaves the original
 *  fence in place in that case. */
function normalizeBlock(raw: unknown): CanvasBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.title !== 'string') return null
  // Escape hatch: { title, spec }
  if (o.spec && typeof o.spec === 'object') {
    return {
      title: o.title,
      subtitle: typeof o.subtitle === 'string' ? o.subtitle : undefined,
      period: typeof o.period === 'string' ? o.period : undefined,
      spec: o.spec as Spec,
    }
  }
  const kind = o.kind
  if (typeof kind !== 'string') return null
  switch (kind) {
    case 'metric':
      if (typeof o.value !== 'number') return null
      return { ...stripBase(o), kind, value: o.value, ...passthroughMetric(o) }
    case 'line':
    case 'bar':
    case 'pie': {
      const series = o.series
      if (!Array.isArray(series)) return null
      return {
        ...stripBase(o),
        kind,
        series: series as Series[],
        xLabel: typeof o.xLabel === 'string' ? o.xLabel : undefined,
        yLabel: typeof o.yLabel === 'string' ? o.yLabel : undefined,
      }
    }
    case 'table':
      if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) return null
      return {
        ...stripBase(o),
        kind,
        columns: o.columns as TableColumn[],
        rows: o.rows as Array<Record<string, unknown>>,
      }
    case 'markdown':
    case 'text':
      if (typeof o.text !== 'string') return null
      return { ...stripBase(o), kind, text: o.text }
    default:
      return null
  }
}

function stripBase(o: Record<string, unknown>): BlockBase {
  return {
    title: String(o.title),
    subtitle: typeof o.subtitle === 'string' ? o.subtitle : undefined,
    period: typeof o.period === 'string' ? o.period : undefined,
  }
}

function passthroughMetric(o: Record<string, unknown>): Omit<MetricBlock, keyof BlockBase | 'kind' | 'value'> {
  return {
    format: typeof o.format === 'string' ? (o.format as MetricBlock['format']) : undefined,
    currency: typeof o.currency === 'string' ? o.currency : undefined,
    caption: typeof o.caption === 'string' ? o.caption : undefined,
    delta: typeof o.delta === 'number' ? o.delta : undefined,
    trend:
      o.trend === 'up' || o.trend === 'down' || o.trend === 'flat'
        ? o.trend
        : undefined,
    invertTrend: typeof o.invertTrend === 'boolean' ? o.invertTrend : undefined,
  }
}

/* ---------------------- shorthand → json-render Spec --------------------- */

/** Compile a `CanvasBlock` into an `ArtifactBundle` ready for the pane. */
export function canvasBlockToBundle(
  block: CanvasBlock,
  opts: { id: string; index: number; turnId: string },
): ArtifactBundle {
  if ('spec' in block) {
    return {
      id: opts.id,
      kind: 'canvas',
      title: block.title,
      summary: block.subtitle ?? '',
      spec: block.spec,
    }
  }
  const spec = compileShorthand(block)
  return {
    id: opts.id,
    kind: `canvas-${block.kind}`,
    title: block.title,
    summary: block.subtitle ?? summarizeForKind(block),
    spec,
  }
}

function summarizeForKind(b: Exclude<CanvasBlock, RawBlock>): string {
  switch (b.kind) {
    case 'metric':
      return `${b.value}`
    case 'table':
      return `${b.rows.length} rows · ${b.columns.length} cols`
    case 'markdown':
    case 'text':
      return b.text.slice(0, 80)
    case 'line':
    case 'bar':
    case 'pie':
      return `${b.series.length} series`
  }
}

function compileShorthand(b: Exclude<CanvasBlock, RawBlock>): Spec {
  const root = 'root'
  // @json-render spec uses `children: string[]` for nesting (NOT `slots`).
  // catalog's `slots: ['default']` only declares which slot names a
  // component accepts — the runtime field on the UIElement is children.
  const elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }> = {}
  const inner = 'body'
  elements[root] = {
    type: 'Frame',
    props: { title: b.title, subtitle: b.subtitle ?? null, period: b.period ?? null },
    children: [inner],
  }
  switch (b.kind) {
    case 'metric':
      elements[inner] = {
        type: 'Metric',
        props: {
          label: b.subtitle ?? b.title,
          value: b.value,
          format: b.format ?? null,
          currency: b.currency ?? null,
          caption: b.caption ?? null,
          delta: b.delta ?? null,
          trend: b.trend ?? null,
          invertTrend: b.invertTrend ?? null,
        },
      }
      break
    case 'line':
    case 'bar':
    case 'pie': {
      const cmp = b.kind === 'line' ? 'LineChart' : b.kind === 'bar' ? 'BarChart' : 'PieChart'
      elements[inner] = {
        type: cmp,
        props: {
          series: b.series,
          xLabel: b.xLabel ?? null,
          yLabel: b.yLabel ?? null,
        },
      }
      break
    }
    case 'table':
      elements[inner] = {
        type: 'DataTable',
        props: { columns: b.columns, rows: b.rows },
      }
      break
    case 'markdown':
    case 'text':
      elements[inner] = {
        type: 'Text',
        props: { text: b.text, tone: null },
      }
      break
  }
  return { root, elements } as unknown as Spec
}

/* ------------------------------ misc utils ------------------------------ */

function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}
