import { memo, useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart as RLineChart,
  Pie,
  PieChart as RPieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ArrowDownRight, ArrowUpRight, Info, Lightbulb, Minus, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type Fmt, formatDelta, formatValue } from './format'
import { chartColor, chartInk, chartLine } from './palette'

/* -------------------------------------------------------------------------- */
/*  Layout primitives                                                         */
/* -------------------------------------------------------------------------- */

export const Frame = memo(function Frame({
  props,
  children,
}: {
  props: { title: string; subtitle?: string | null; period?: string | null }
  children?: React.ReactNode
}) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-line bg-surface">
      <header className="relative flex items-start justify-between gap-4 border-b border-line px-6 pb-5 pt-5">
        <div
          aria-hidden
          className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.018em] text-ink">
              {props.title}
            </h2>
            {props.period && (
              <span className="pill pill-muted text-[10px] font-mono normal-case">
                {props.period}
              </span>
            )}
          </div>
          {props.subtitle && (
            <p className="mt-1.5 max-w-[60ch] text-[12.5px] leading-[1.55] text-ink-muted">
              {props.subtitle}
            </p>
          )}
        </div>
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </section>
  )
})

export const Stack = memo(function Stack({
  props,
  children,
}: {
  props: { direction?: 'vertical' | 'horizontal' | null; gap?: number | null; wrap?: boolean | null }
  children?: React.ReactNode
}) {
  const dir = props.direction === 'horizontal' ? 'flex-row' : 'flex-col'
  const gap = props.gap ?? 4
  const gapClass = `gap-${Math.min(8, Math.max(1, gap))}`
  return (
    <div className={cn('flex w-full', dir, gapClass, props.wrap && 'flex-wrap')}>{children}</div>
  )
})

export const Heading = memo(function Heading({
  props,
}: {
  props: { text: string; level?: 'h2' | 'h3' | null }
}) {
  if (props.level === 'h3') {
    return (
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-dim">
        {props.text}
      </h3>
    )
  }
  return (
    <h3 className="text-[14px] font-semibold tracking-[-0.005em] text-ink">{props.text}</h3>
  )
})

export const Text = memo(function Text({
  props,
}: {
  props: { text: string; tone?: ToneKey | null }
}) {
  return (
    <p
      className={cn(
        'text-[12.5px] leading-[1.55]',
        props.tone === 'good' && 'text-ok',
        props.tone === 'warn' && 'text-warn',
        props.tone === 'bad' && 'text-bad',
        props.tone === 'accent' && 'text-accent',
        (!props.tone || props.tone === 'neutral') && 'text-ink-muted',
      )}
    >
      {props.text}
    </p>
  )
})

/* -------------------------------------------------------------------------- */
/*  Metric                                                                    */
/* -------------------------------------------------------------------------- */

type MetricProps = {
  label: string
  value: number
  format?: Fmt | null
  currency?: string | null
  caption?: string | null
  delta?: number | null
  trend?: 'up' | 'down' | 'flat' | null
  invertTrend?: boolean | null
}

export const Metric = memo(function Metric({ props }: { props: MetricProps }) {
  const { delta, trend, invertTrend } = props
  const inferTrend: MetricProps['trend'] | undefined =
    trend ?? (typeof delta === 'number' ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : undefined)

  const semanticUp = invertTrend ? 'bad' : 'ok'
  const semanticDown = invertTrend ? 'ok' : 'bad'
  const trendKey =
    inferTrend === 'up' ? semanticUp : inferTrend === 'down' ? semanticDown : 'flat'

  const Icon = inferTrend === 'up' ? ArrowUpRight : inferTrend === 'down' ? ArrowDownRight : Minus
  return (
    <div
      className={cn(
        'group relative flex flex-1 flex-col rounded-lg border border-line bg-surface-2 px-4 py-3.5',
        'transition-colors duration-200 ease-out-quart',
        'hover:border-line-strong',
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-dim">
        {props.label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tabular-nums tracking-[-0.015em] text-ink">
          {formatValue(props.value, props.format ?? null, props.currency ?? '¥')}
        </span>
      </div>
      <div className="mt-1.5 flex min-h-[16px] items-center justify-between text-[11px]">
        <span className="text-ink-dim">{props.caption ?? ''}</span>
        {typeof delta === 'number' && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-mono tabular-nums',
              trendKey === 'ok' && 'text-ok',
              trendKey === 'bad' && 'text-bad',
              trendKey === 'flat' && 'text-ink-dim',
            )}
          >
            <Icon className="h-3 w-3" />
            {formatDelta(delta)}
          </span>
        )}
      </div>
    </div>
  )
})

/* -------------------------------------------------------------------------- */
/*  Charts — recharts wrappers                                                */
/* -------------------------------------------------------------------------- */

interface SeriesPoint {
  x: string | number
  y: number
}
interface NamedSeries {
  name: string
  color?: string | null
  format?: Fmt | null
  points: SeriesPoint[]
}

/** Pivot per-series data into recharts' "tidy" rows: { x, [seriesName]: y }. */
function pivot(series: NamedSeries[]): Array<Record<string, string | number>> {
  const xs: (string | number)[] = []
  for (const s of series) for (const p of s.points) if (!xs.includes(p.x)) xs.push(p.x)
  return xs.map((x) => {
    const row: Record<string, string | number> = { x }
    for (const s of series) {
      const p = s.points.find((pp) => pp.x === x)
      if (p) row[s.name] = p.y
    }
    return row
  })
}

function tickFmt(fmt: Fmt) {
  return (v: number) => formatValue(v, fmt ?? 'compact')
}

const CHART_TOOLTIP_STYLE: React.CSSProperties = {
  background: 'oklch(var(--surface-2-l) var(--surface-2-c) var(--surface-2-h))',
  border: '1px solid oklch(var(--line-strong-l) var(--line-strong-c) var(--line-strong-h))',
  borderRadius: '8px',
  padding: '8px 10px',
  fontSize: '12px',
  color: 'oklch(var(--ink-l) var(--ink-c) var(--ink-h))',
  boxShadow: '0 12px 24px -12px rgba(0,0,0,0.35)',
}

function ChartTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string | number
  fmt: Fmt
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={CHART_TOOLTIP_STYLE}>
      {label != null && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
          {label}
        </div>
      )}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 leading-tight">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: p.color }}
            aria-hidden
          />
          <span className="text-ink-muted">{p.name}</span>
          <span className="ml-auto font-mono tabular-nums text-ink">
            {formatValue(p.value, fmt)}
          </span>
        </div>
      ))}
    </div>
  )
}

export const LineChart = memo(function LineChart({
  props,
}: {
  props: {
    series: NamedSeries[]
    height?: number | null
    area?: boolean | null
    yFormat?: Fmt | null
  }
}) {
  const data = useMemo(() => pivot(props.series), [props.series])
  const ink = chartInk('dim')
  const lineColor = chartLine()
  const Chart = props.area ? AreaChart : RLineChart
  const SeriesEl: React.ElementType = props.area ? Area : Line

  return (
    <div style={{ height: props.height ?? 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid stroke={lineColor} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="x"
            stroke={ink}
            tick={{ fill: ink, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: lineColor }}
          />
          <YAxis
            stroke={ink}
            tick={{ fill: ink, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={tickFmt(props.yFormat ?? null)}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: lineColor, strokeWidth: 1 }}
            content={<ChartTooltip fmt={props.yFormat ?? null} />}
          />
          {props.series.length > 1 && (
            <Legend
              iconType="circle"
              iconSize={8}
              verticalAlign="top"
              align="right"
              wrapperStyle={{ fontSize: 11, color: ink, paddingBottom: 4 }}
            />
          )}
          {props.series.map((s, i) => {
            const color = resolveColor(s.color, i)
            return (
              <SeriesEl
                key={s.name}
                type="monotone"
                dataKey={s.name}
                stroke={color}
                strokeWidth={2}
                fill={color}
                fillOpacity={props.area ? 0.18 : 0}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive
                animationDuration={420}
                animationEasing="ease-out"
              />
            )
          })}
        </Chart>
      </ResponsiveContainer>
    </div>
  )
})

export const BarChart = memo(function BarChart({
  props,
}: {
  props: {
    series: NamedSeries[]
    height?: number | null
    stacked?: boolean | null
    horizontal?: boolean | null
    yFormat?: Fmt | null
  }
}) {
  const data = useMemo(() => pivot(props.series), [props.series])
  const ink = chartInk('dim')
  const lineColor = chartLine()
  const layout = props.horizontal ? 'vertical' : 'horizontal'
  return (
    <div style={{ height: props.height ?? 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RBarChart
          layout={layout}
          data={data}
          margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          barCategoryGap={props.horizontal ? 8 : 18}
        >
          <CartesianGrid
            stroke={lineColor}
            strokeDasharray="3 3"
            horizontal={!props.horizontal}
            vertical={!!props.horizontal}
          />
          {props.horizontal ? (
            <>
              <XAxis
                type="number"
                stroke={ink}
                tick={{ fill: ink, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: lineColor }}
                tickFormatter={tickFmt(props.yFormat ?? null)}
              />
              <YAxis
                type="category"
                dataKey="x"
                stroke={ink}
                tick={{ fill: ink, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={88}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey="x"
                stroke={ink}
                tick={{ fill: ink, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: lineColor }}
              />
              <YAxis
                stroke={ink}
                tick={{ fill: ink, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={tickFmt(props.yFormat ?? null)}
                width={56}
              />
            </>
          )}
          <Tooltip
            cursor={{ fill: 'oklch(var(--surface-3-l) var(--surface-3-c) var(--surface-3-h) / 0.5)' }}
            content={<ChartTooltip fmt={props.yFormat ?? null} />}
          />
          {props.series.length > 1 && (
            <Legend
              iconType="circle"
              iconSize={8}
              verticalAlign="top"
              align="right"
              wrapperStyle={{ fontSize: 11, color: ink, paddingBottom: 4 }}
            />
          )}
          {props.series.map((s, i) => (
            <Bar
              key={s.name}
              dataKey={s.name}
              fill={resolveColor(s.color, i)}
              stackId={props.stacked ? 'a' : undefined}
              radius={[3, 3, 0, 0]}
              isAnimationActive
              animationDuration={420}
              animationEasing="ease-out"
            />
          ))}
        </RBarChart>
      </ResponsiveContainer>
    </div>
  )
})

export const PieChart = memo(function PieChart({
  props,
}: {
  props: {
    slices: Array<{ label: string; value: number; color?: string | null }>
    format?: Fmt | null
    height?: number | null
  }
}) {
  return (
    <div style={{ height: props.height ?? 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RPieChart>
          <Pie
            data={props.slices.map((s, i) => ({
              ...s,
              fill: resolveColor(s.color, i),
            }))}
            dataKey="value"
            nameKey="label"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={2}
            isAnimationActive
            animationDuration={420}
            stroke="oklch(var(--surface-l) var(--surface-c) var(--surface-h))"
            strokeWidth={2}
          >
            {props.slices.map((s, i) => (
              <Cell key={s.label} fill={resolveColor(s.color, i)} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip fmt={props.format ?? null} />} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{
              fontSize: 11,
              color: chartInk('dim'),
              paddingTop: 8,
            }}
          />
        </RPieChart>
      </ResponsiveContainer>
    </div>
  )
})

/* -------------------------------------------------------------------------- */
/*  Data table                                                                */
/* -------------------------------------------------------------------------- */

interface Column {
  header: string
  key: string
  format?: Fmt | null
  align?: 'start' | 'center' | 'end' | null
  width?: number | null
}

export const DataTable = memo(function DataTable({
  props,
}: {
  props: {
    columns: Column[]
    rows: Array<Record<string, string | number | null>>
    highlightOutliers?: { key: string; low: number | null; high: number | null } | null
  }
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-surface-2">
            {props.columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-dim',
                  col.align === 'end' && 'text-right',
                  col.align === 'center' && 'text-center',
                  (!col.align || col.align === 'start') && 'text-left',
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, idx) => {
            const out = props.highlightOutliers
            let outlier = false
            if (out) {
              const v = row[out.key]
              if (typeof v === 'number') {
                if (out.low != null && v < out.low) outlier = true
                if (out.high != null && v > out.high) outlier = true
              }
            }
            return (
              <tr
                key={idx}
                className={cn(
                  'transition-colors duration-150 ease-out-quart hover:bg-surface-2/60',
                  outlier && 'bg-bad/10',
                )}
              >
                {props.columns.map((col) => {
                  const raw = row[col.key]
                  const text =
                    raw == null
                      ? '—'
                      : typeof raw === 'number'
                        ? formatValue(raw, col.format ?? null)
                        : String(raw)
                  const isNumeric = typeof raw === 'number'
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        'border-b border-line px-3 py-2 last:border-b-0',
                        isNumeric && 'font-mono tabular-nums',
                        col.align === 'end' && 'text-right',
                        col.align === 'center' && 'text-center',
                        (!col.align || col.align === 'start') && 'text-left',
                        outlier ? 'text-bad' : 'text-ink',
                      )}
                    >
                      {text}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

/* -------------------------------------------------------------------------- */
/*  Callout                                                                   */
/* -------------------------------------------------------------------------- */

type ToneKey = 'neutral' | 'good' | 'warn' | 'bad' | 'accent'

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  info: Info,
  warn: ShieldAlert,
  ok: Sparkles,
  bad: ShieldAlert,
  spark: Lightbulb,
}

export const Callout = memo(function Callout({
  props,
  children,
}: {
  props: { title?: string | null; tone?: ToneKey | null; icon?: string | null }
  children?: React.ReactNode
}) {
  const tone: ToneKey = props.tone ?? 'accent'
  const Icon = props.icon ? (ICONS[props.icon] ?? Lightbulb) : Lightbulb
  return (
    <aside
      className={cn(
        'flex gap-3 rounded-md border px-4 py-3',
        tone === 'good' && 'border-ok/30 bg-ok-tint',
        tone === 'warn' && 'border-warn/30 bg-warn-tint',
        tone === 'bad' && 'border-bad/30 bg-bad-tint',
        tone === 'accent' && 'border-accent/30 bg-accent-tint',
        tone === 'neutral' && 'border-line bg-surface-2',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'good' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
          tone === 'accent' && 'text-accent',
          tone === 'neutral' && 'text-ink-muted',
        )}
      />
      <div className="min-w-0 flex-1">
        {props.title && (
          <div
            className={cn(
              'mb-0.5 text-[12px] font-semibold tracking-[-0.005em]',
              tone === 'good' && 'text-ok',
              tone === 'warn' && 'text-warn',
              tone === 'bad' && 'text-bad',
              tone === 'accent' && 'text-accent-hi',
              tone === 'neutral' && 'text-ink',
            )}
          >
            {props.title}
          </div>
        )}
        <div
          className={cn(
            'text-[12.5px] leading-[1.55]',
            tone === 'good' && 'text-ok/85',
            tone === 'warn' && 'text-warn/90',
            tone === 'bad' && 'text-bad/90',
            tone === 'accent' && 'text-ink',
            tone === 'neutral' && 'text-ink-muted',
          )}
        >
          {children}
        </div>
      </div>
    </aside>
  )
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function resolveColor(named: string | null | undefined, fallbackIndex: number): string {
  if (named && named.trim().startsWith('oklch') /* allow inline */) return named
  if (named && /^#|^rgb|^hsl/.test(named)) return named
  if (named === 'accent') return chartColor(0)
  if (named === 'teal') return chartColor(1)
  if (named === 'amber') return chartColor(2)
  if (named === 'violet') return chartColor(3)
  if (named === 'sage') return chartColor(4)
  if (named === 'rose') return chartColor(5)
  return chartColor(fallbackIndex)
}
