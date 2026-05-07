/**
 * Number / value formatters used by Metric, charts, and table cells.
 *
 * The agent emits numeric values in their natural unit (yuan, hours,
 * fractions). Formatting is the renderer's job — keeps the spec stable
 * regardless of locale/UI preferences.
 */

export type Fmt =
  | 'number'
  | 'currency'
  | 'percent'
  | 'duration_h'
  | 'compact'
  | null
  | undefined

const cnyZero: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 0,
}

const compactZero: Intl.NumberFormatOptions = {
  notation: 'compact',
  maximumFractionDigits: 1,
}

const cnyCompact: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'CNY',
  notation: 'compact',
  maximumFractionDigits: 1,
}

export function formatValue(value: number, fmt: Fmt, currency = '¥'): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  if (fmt === 'currency') {
    if (Math.abs(value) >= 10_000) {
      return new Intl.NumberFormat('zh-CN', cnyCompact).format(value).replace('¥', currency)
    }
    return new Intl.NumberFormat('zh-CN', cnyZero).format(value).replace('¥', currency)
  }
  if (fmt === 'percent') {
    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(value)
  }
  if (fmt === 'duration_h') {
    const rounded = Math.round(value * 10) / 10
    return `${rounded.toLocaleString('zh-CN')} h`
  }
  if (fmt === 'compact') {
    return new Intl.NumberFormat('zh-CN', compactZero).format(value)
  }
  // number / null / undefined
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('zh-CN', compactZero).format(value)
  }
  return value.toLocaleString('zh-CN')
}

export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  return (
    sign +
    new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(delta)
  )
}
