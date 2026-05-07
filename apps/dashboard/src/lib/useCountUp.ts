import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

interface Options {
  /** Tween duration in ms. Default 600. */
  durationMs?: number
  /** Easing — exposed in case a caller wants linear. Default ease-out-cubic. */
  ease?: (t: number) => number
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Smoothly tween a numeric KPI from its previous value to `target`.
 *
 * - First mount: tweens from 0 → target so the first paint feels alive.
 * - Subsequent updates: tweens from the previously displayed value to
 *   the new target (so KPIs feel "responsive" when refresh ticks).
 * - `prefers-reduced-motion`: returns the target immediately.
 * - `null`/`undefined`/non-finite targets: returns the input unchanged
 *   so caller can decide how to render `—` etc.
 */
export function useCountUp(
  target: number | null | undefined,
  opts: Options = {},
): number | null | undefined {
  const { durationMs = 600, ease = easeOutCubic } = opts
  const reduce = usePrefersReducedMotion()
  const [display, setDisplay] = useState<number>(typeof target === 'number' && Number.isFinite(target) ? (reduce ? target : 0) : 0)
  const fromRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (target === null || target === undefined || !Number.isFinite(target)) return
    if (reduce) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const from = fromRef.current
    const to = target
    if (from === to) return
    startRef.current = performance.now()
    const tick = (t: number) => {
      const elapsed = t - startRef.current
      const k = Math.min(1, elapsed / durationMs)
      const v = from + (to - from) * ease(k)
      setDisplay(v)
      if (k < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
        rafRef.current = null
      }
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [target, durationMs, ease, reduce])

  if (target === null || target === undefined || !Number.isFinite(target as number)) {
    return target
  }
  return display
}
