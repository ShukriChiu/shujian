import { memo, useEffect, useId, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// — shiki highlighter, singleton, lazy-loaded with both themes —
type ShikiHighlighter = {
  codeToHtml: (
    code: string,
    opts: { lang: string; theme: string },
  ) => string
  getLoadedLanguages: () => string[]
  loadLanguage: (lang: string | string[]) => Promise<void>
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null

/**
 * Start with zero langs in the bundle. We `loadLanguage` lazily as code
 * blocks appear, which keeps the dashboard chunk small (each grammar is
 * 50-300KB raw).
 */
function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['vitesse-dark', 'vitesse-light'],
        langs: [],
      }) as Promise<ShikiHighlighter>,
    )
  }
  return highlighterPromise
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  text: 'plaintext',
  txt: 'plaintext',
  '': 'plaintext',
}

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase()
  return LANG_ALIASES[lower] ?? lower
}

/** Observe `<html>` class to flip the shiki theme between dark/light. */
function useThemeMode(): 'dark' | 'light' {
  const [mode, setMode] = useState<'dark' | 'light'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark',
  )
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => {
      setMode(root.classList.contains('light') ? 'light' : 'dark')
    })
    obs.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return mode
}

interface CodeBlockProps {
  code: string
  lang: string
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: CodeBlockProps) {
  const mode = useThemeMode()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setError(null)
    setHtml(null)
    ;(async () => {
      try {
        const hl = await getHighlighter()
        const normalized = normalizeLang(lang)
        const loaded = hl.getLoadedLanguages()
        if (!loaded.includes(normalized) && normalized !== 'plaintext') {
          try {
            await hl.loadLanguage(normalized)
          } catch {
            /* unknown lang → falls through to plaintext */
          }
        }
        const finalLang = hl.getLoadedLanguages().includes(normalized) ? normalized : 'plaintext'
        const theme = mode === 'light' ? 'vitesse-light' : 'vitesse-dark'
        const out = hl.codeToHtml(code, { lang: finalLang, theme })
        if (alive) setHtml(out)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [code, lang, mode])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — silent fail is fine */
    }
  }

  return (
    <div className="group/code mb-2 overflow-hidden rounded-md border border-line bg-surface-2 last:mb-0">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
        <span>{lang || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-150 ease-out-quart',
            'text-ink-dim hover:bg-surface-3 hover:text-ink',
          )}
        >
          {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {error ? (
        <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-relaxed text-bad scroll-thin">
          {code}
        </pre>
      ) : html ? (
        <div
          className="shiki-container scroll-thin overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-dim">
          <Loader2 className="h-3 w-3 animate-spin" />
          highlighting…
        </div>
      )}
    </div>
  )
})

// — mermaid lazy renderer — themed dynamically
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let mermaidThemeMode: 'dark' | 'light' | null = null

function getMermaid(mode: 'dark' | 'light') {
  if (!mermaidPromise || mermaidThemeMode !== mode) {
    mermaidThemeMode = mode
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables:
          mode === 'light'
            ? {
                fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif',
                fontSize: '13px',
                primaryColor: '#fef3e7',
                primaryTextColor: '#2a2520',
                primaryBorderColor: '#d97f4f',
                lineColor: '#7a6a55',
                background: '#fafaf6',
              }
            : {
                fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif',
                fontSize: '13px',
                primaryColor: '#3a2c1f',
                primaryTextColor: '#f5ede0',
                primaryBorderColor: '#e89360',
                lineColor: '#a08a6a',
                background: '#1a1410',
              },
        securityLevel: 'strict',
      })
      return mermaid
    })
  }
  return mermaidPromise
}

interface MermaidBlockProps {
  code: string
}

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const mode = useThemeMode()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')

  useEffect(() => {
    let alive = true
    setError(null)
    setSvg(null)
    ;(async () => {
      try {
        const m = await getMermaid(mode)
        const { svg } = await m.render(`m${id}`, code)
        if (alive) setSvg(svg)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [code, id, mode])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-line bg-surface-2 last:mb-0">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-dim">
        <span>mermaid</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-dim transition-colors duration-150 ease-out-quart hover:bg-surface-3 hover:text-ink"
        >
          {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {error ? (
        <div className="space-y-1 p-2.5">
          <div className="text-[11px] font-medium text-bad">Mermaid 渲染失败</div>
          <pre className="overflow-x-auto rounded bg-surface px-2 py-1 text-[11px] text-bad scroll-thin">
            {error}
          </pre>
          <pre className="overflow-x-auto rounded bg-surface px-2 py-1 text-[11px] text-ink-muted scroll-thin">
            {code}
          </pre>
        </div>
      ) : svg ? (
        <div
          className="overflow-x-auto p-3 [&>svg]:mx-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-ink-dim">
          <Loader2 className="h-3 w-3 animate-spin" />
          rendering diagram…
        </div>
      )}
    </div>
  )
})
