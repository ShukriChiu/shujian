import { useEffect, useState } from 'react'

/**
 * Live read of the user's `prefers-reduced-motion` media query.
 *
 * Components opt in to disabling count-up tweens, slide animations and
 * auto-pulses by gating effects on this hook. We also gate one-shot
 * `transition`s by reading the value at render time (not via CSS) so
 * Tailwind classes remain compile-time static.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduce(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduce
}
