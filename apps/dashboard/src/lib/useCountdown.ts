import { useEffect, useState } from 'react'

/**
 * Live countdown to a unix-seconds timestamp. Re-renders once per second
 * (cheap because we throttle to whole-second ticks). Returns:
 *   - `secondsLeft` — clamped to ≥0
 *   - `expired`     — true once we crossed `targetSec`
 *   - `label`       — pre-formatted "23m 04s" / "—" / "expired"
 *
 * Pass `null` to disable (returns 0/false/"—").
 */
export function useCountdown(targetSec: number | null | undefined): {
  secondsLeft: number
  expired: boolean
  label: string
} {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (targetSec === null || targetSec === undefined) return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [targetSec])

  if (targetSec === null || targetSec === undefined) {
    return { secondsLeft: 0, expired: false, label: '—' }
  }
  const secondsLeft = Math.max(0, targetSec - now)
  const expired = secondsLeft === 0
  return { secondsLeft, expired, label: formatLabel(secondsLeft, expired) }
}

function formatLabel(s: number, expired: boolean): string {
  if (expired) return 'expired'
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}h ${m.toString().padStart(2, '0')}m`
  }
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}m ${sec.toString().padStart(2, '0')}s`
  }
  return `${s}s`
}
