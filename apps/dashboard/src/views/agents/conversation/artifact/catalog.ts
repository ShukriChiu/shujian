import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { z } from 'zod'

/**
 * Business analytics catalog.
 *
 * The agent emits JSON specs constrained to these components, the renderer
 * maps them to React. Adding a new component means: add it here, implement
 * it in `components.tsx`, register it in `registry.ts`. The agent prompt
 * is auto-generated from these descriptions via `catalog.prompt()`.
 */

const numberFormat = z.enum(['number', 'currency', 'percent', 'duration_h', 'compact']).nullable()
const trend = z.enum(['up', 'down', 'flat']).nullable()
const tone = z.enum(['neutral', 'good', 'warn', 'bad', 'accent']).nullable()
const align = z.enum(['start', 'center', 'end']).nullable()
const direction = z.enum(['vertical', 'horizontal']).nullable()

const seriesPoint = z.object({
  /** X-axis label (month name, segment, etc.) */
  x: z.union([z.string(), z.number()]),
  /** Numeric Y value */
  y: z.number(),
})

const namedSeries = z.object({
  /** Series label shown in legend */
  name: z.string(),
  /** Color token name; falls back to palette index */
  color: z.string().nullable(),
  /** Numeric format applied to Y values */
  format: numberFormat,
  /** Data points */
  points: z.array(seriesPoint),
})

const tableColumn = z.object({
  /** Header label */
  header: z.string(),
  /** Object key in row data */
  key: z.string(),
  /** Format hint for cell values */
  format: numberFormat,
  /** Right-align numeric, left-align text */
  align: align,
  /** Optional fixed width in chars (mono cells) */
  width: z.number().nullable(),
})

export const businessCatalog = defineCatalog(schema, {
  components: {
    Frame: {
      slots: ['default'],
      description:
        'Top-level container for an artifact. Always the root element. ' +
        'Renders as a card with title, optional subtitle, and a toolbar.',
      props: z.object({
        title: z.string(),
        subtitle: z.string().nullable(),
        /** Optional context tag, e.g. "Q3 2025" */
        period: z.string().nullable(),
      }),
    },

    Stack: {
      slots: ['default'],
      description:
        'Vertical or horizontal flex container. Use direction="horizontal" for ' +
        'metric rows, "vertical" (default) for stacked sections.',
      props: z.object({
        direction: direction,
        /** Tailwind gap scale (1-8), default 4 */
        gap: z.number().nullable(),
        /** Wrap children when horizontal */
        wrap: z.boolean().nullable(),
      }),
    },

    Heading: {
      slots: [],
      description: 'Section heading inside an artifact (h2/h3 visual).',
      props: z.object({
        text: z.string(),
        level: z.enum(['h2', 'h3']).nullable(),
      }),
    },

    Text: {
      slots: [],
      description: 'Paragraph of body text. Use sparingly between charts.',
      props: z.object({
        text: z.string(),
        tone: tone,
      }),
    },

    Metric: {
      slots: [],
      description:
        'Single big number with label and optional delta. Use for KPIs ' +
        '(总营收、退款率、未消课时小时数). Delta is the % change vs comparison period.',
      props: z.object({
        label: z.string(),
        value: z.number(),
        format: numberFormat,
        /** Currency symbol, only if format=currency. Defaults to ¥. */
        currency: z.string().nullable(),
        /** Sub-label below value (e.g. "环比 Q2") */
        caption: z.string().nullable(),
        /** % change as a decimal: 0.124 = +12.4% */
        delta: z.number().nullable(),
        /** "up" = green / "down" = red / "flat" = neutral. Override semantics with goodWhen. */
        trend: trend,
        /** Inverts trend coloring (e.g. for refund rate, "down" should be green). */
        invertTrend: z.boolean().nullable(),
      }),
    },

    LineChart: {
      slots: [],
      description:
        'Time-series or trend line chart. Multi-series supported. X-axis ' +
        'is categorical (month names ok). Use this for trends over months.',
      props: z.object({
        series: z.array(namedSeries),
        height: z.number().nullable(),
        /** Show area fill under lines (helps with single-series). */
        area: z.boolean().nullable(),
        yFormat: numberFormat,
      }),
    },

    BarChart: {
      slots: [],
      description:
        'Categorical bar chart. Use for segment comparison (业务线对比、城市对比). ' +
        'Multi-series shows grouped bars.',
      props: z.object({
        series: z.array(namedSeries),
        height: z.number().nullable(),
        /** Stack bars instead of group. */
        stacked: z.boolean().nullable(),
        /** Make bars horizontal (good for long category labels). */
        horizontal: z.boolean().nullable(),
        yFormat: numberFormat,
      }),
    },

    PieChart: {
      slots: [],
      description: 'Donut chart for share-of-total. Limit to 6 slices.',
      props: z.object({
        slices: z.array(
          z.object({
            label: z.string(),
            value: z.number(),
            color: z.string().nullable(),
          }),
        ),
        format: numberFormat,
        height: z.number().nullable(),
      }),
    },

    DataTable: {
      slots: [],
      description:
        'Tabular data with typed columns. Use for staff KPI lists, ' +
        'unconsumed lessons by class, etc.',
      props: z.object({
        columns: z.array(tableColumn),
        rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
        /** Highlight rows whose key value falls outside [low, high] */
        highlightOutliers: z
          .object({
            key: z.string(),
            low: z.number().nullable(),
            high: z.number().nullable(),
          })
          .nullable(),
      }),
    },

    Callout: {
      slots: ['default'],
      description:
        'Highlighted insight box. Use for AI commentary that frames the ' +
        'data: trend explanations, action recommendations, anomalies.',
      props: z.object({
        title: z.string().nullable(),
        tone: tone,
        /** Optional icon hint: "info" | "warn" | "ok" | "bad" | "spark". */
        icon: z.string().nullable(),
      }),
    },
  },
  actions: {
    drill_down: {
      description:
        'Request a deeper analysis. Call when the user clicks a "看明细" button. ' +
        'Params: { topic: string }',
      params: z.object({ topic: z.string() }),
    },
    export_artifact: {
      description: 'Export the current artifact as PNG / Markdown.',
      params: z.object({ format: z.enum(['png', 'markdown']) }),
    },
  },
})

export type BusinessCatalog = typeof businessCatalog
