import { useEffect, useRef, useState } from 'react'

/**
 * The "the platform is alive" left panel of the login page.
 *
 * Two synchronised animations:
 * 1. A scrolling sparkline at the top, 1px stroke, accent-tinted, fed by a
 *    seeded RNG so the trace looks plausible (slow drift + occasional spike).
 * 2. An event ticker that streams scripted ops messages bottom-up.
 *
 * Both use a single rAF loop, throttled to ~24 fps to stay quiet on CPU.
 * Both freeze on `prefers-reduced-motion`.
 */

const TICKER_SCRIPTS: Array<[label: string, body: string, tone: 'ok' | 'warn' | 'info']> = [
  ['queue.scheduled', 'agent=cleanup-archive · cron=0 3 * * *', 'info'],
  ['runtime.boot', 'shujian-agent v0.4.2 listening on :8002', 'ok'],
  ['cursor.run.finished', 'gpt-5 · 27.4s · pr opened', 'ok'],
  ['vault.read', 'workspace=ops · vault=stripe-prod', 'info'],
  ['agent.spawn', 'cloud · model=claude-4.6-sonnet · ref=main', 'info'],
  ['cursor.run.finished', 'composer-3 · 12.1s · skipped', 'ok'],
  ['session.refresh', 'tenant=onion · user=admin', 'info'],
  ['runtime.task.queued', 'agent=fix-tests · concurrency=2/4', 'info'],
  ['cursor.run.queued', 'gpt-5-codex · queue depth 3', 'warn'],
  ['vault.rotate', 'cursor-key · 30d window', 'info'],
  ['cursor.run.finished', 'sonnet-4.6 · 8.2s · noop', 'ok'],
  ['runtime.health', 'tasks_completed=148 · failed=2', 'ok'],
]

const REDUCE_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function SystemPulse() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const fillRef = useRef<SVGPathElement>(null)
  const cursorRef = useRef<SVGCircleElement>(null)
  const [tick, setTick] = useState(0)
  type Line = { id: number; t: number; label: string; body: string; tone: 'ok' | 'warn' | 'info' }
  const [lines, setLines] = useState<Line[]>([])

  // sparkline state — stored as N points spanning the SVG width
  const N = 96
  const W = 600
  const H = 96
  useEffect(() => {
    const seed = Array.from({ length: N }, (_, i) => 0.5 + 0.18 * Math.sin(i * 0.32))
    let raf = 0
    let last = 0
    let phase = 0
    let next = 0.5
    const data = [...seed]

    const render = (now: number) => {
      raf = requestAnimationFrame(render)
      if (REDUCE_MOTION) {
        // single static draw, then exit the loop
        drawPath(data)
        cancelAnimationFrame(raf)
        return
      }
      if (now - last < 1000 / 24) return
      last = now
      phase += 0.06
      // gentle drift + rare spike (~3% of frames)
      const drift = 0.5 + 0.12 * Math.sin(phase) + 0.06 * Math.sin(phase * 2.7 + 1.1)
      const spike = Math.random() < 0.03 ? (Math.random() - 0.4) * 0.45 : 0
      next = clamp(drift + spike + (Math.random() - 0.5) * 0.06, 0.05, 0.95)
      data.shift()
      data.push(next)
      drawPath(data)
    }

    const drawPath = (vals: number[]) => {
      const stepX = W / (vals.length - 1)
      let d = ''
      let f = ''
      for (let i = 0; i < vals.length; i++) {
        const x = i * stepX
        const y = H - vals[i]! * (H - 6) - 3
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `
        f += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `
      }
      f += `L${W} ${H} L0 ${H} Z`
      pathRef.current?.setAttribute('d', d.trim())
      fillRef.current?.setAttribute('d', f.trim())
      const lastY = H - vals[vals.length - 1]! * (H - 6) - 3
      cursorRef.current?.setAttribute('cx', String(W - 0.5))
      cursorRef.current?.setAttribute('cy', String(lastY))
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [])

  // event ticker — push a new scripted line every ~1.4s
  useEffect(() => {
    if (REDUCE_MOTION) {
      setLines(
        TICKER_SCRIPTS.slice(0, 6).map((s, i) => ({
          id: i,
          t: Date.now() - (5 - i) * 1400,
          label: s[0],
          body: s[1],
          tone: s[2],
        })),
      )
      return
    }
    let i = 0
    setTick(0)
    const id = window.setInterval(() => {
      const script = TICKER_SCRIPTS[i % TICKER_SCRIPTS.length]!
      i += 1
      setLines((prev) => {
        const next = [
          { id: Date.now() + i, t: Date.now(), label: script[0], body: script[1], tone: script[2] },
          ...prev,
        ]
        return next.slice(0, 8)
      })
      setTick((t) => t + 1)
    }, 1400)
    // seed with two initial entries so the panel isn't empty on first paint
    setLines([
      {
        id: 1,
        t: Date.now(),
        label: TICKER_SCRIPTS[0]![0],
        body: TICKER_SCRIPTS[0]![1],
        tone: TICKER_SCRIPTS[0]![2],
      },
    ])
    return () => clearInterval(id)
  }, [])

  return (
    <div ref={wrapRef} className="relative flex h-full flex-col justify-between p-10">
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.18em] text-ink-dim">
          <span className="dot dot-running" aria-hidden />
          live · platform pulse
        </div>
        <h2 className="max-w-[420px] text-[28px] font-semibold leading-[34px] tracking-[-0.022em] text-ink">
          一处掌控 <span className="text-accent">本地</span> 与 <span className="text-accent">云端</span> 上的所有 agent。
        </h2>
        <p className="max-w-[400px] text-sm leading-relaxed text-ink-muted">
          Register 把 shujian-agent (Rust) 与 N×Cursor cloud 桥统一到同一个控制面：路由、凭证、审计、计费，一屏管完。
        </p>
      </div>

      {/* sparkline */}
      <div className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-[96px] w-full text-accent"
          role="img"
          aria-label="System pulse"
        >
          <defs>
            <linearGradient id="pulse-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path ref={fillRef} fill="url(#pulse-fill)" />
          <path
            ref={pathRef}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle ref={cursorRef} r="2.4" fill="currentColor" />
        </svg>

        <div className="mt-6 max-h-[180px] space-y-1 overflow-hidden">
          {lines.map((l, idx) => (
            <div
              key={l.id}
              className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 font-mono text-[11px] leading-[18px]"
              style={{ opacity: Math.max(0.18, 1 - idx * 0.14) }}
            >
              <span className="truncate text-ink-dim">
                {new Date(l.t).toLocaleTimeString('en-GB', { hour12: false })}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={
                    l.tone === 'ok'
                      ? 'text-ok'
                      : l.tone === 'warn'
                        ? 'text-warn'
                        : 'text-ink-muted'
                  }
                >
                  {l.label}
                </span>
                <span className="truncate text-ink-dim">{l.body}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 text-[11px] font-mono text-ink-dim">
        <span>v0.4.2</span>
        <span aria-hidden>·</span>
        <span>build {String(tick).padStart(4, '0')}</span>
        <span aria-hidden>·</span>
        <span>railway · ord1</span>
      </div>
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
