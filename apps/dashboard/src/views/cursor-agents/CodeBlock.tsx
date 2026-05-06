import { memo, useEffect, useId, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// — shiki highlighter, singleton, lazy-loaded —
type ShikiHighlighter = {
  codeToHtml: (
    code: string,
    opts: {
      lang: string
      theme: string
    },
  ) => string
  getLoadedLanguages: () => string[]
  loadLanguage: (lang: string | string[]) => Promise<void>
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null

const COMMON_LANGS = [
  'bash',
  'shell',
  'sh',
  'zsh',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'markdown',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'rust',
  'go',
  'html',
  'css',
  'sql',
  'dockerfile',
  'diff',
  'plaintext',
] as const

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-light'],
        langs: COMMON_LANGS as unknown as string[],
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

interface CodeBlockProps {
  code: string
  lang: string
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: CodeBlockProps) {
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
            // unknown language → fall back to plaintext below
          }
        }
        const finalLang = hl.getLoadedLanguages().includes(normalized) ? normalized : 'plaintext'
        const out = hl.codeToHtml(code, { lang: finalLang, theme: 'github-light' })
        if (alive) setHtml(out)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [code, lang])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="group/code mb-2 overflow-hidden rounded-lg border border-ink-200 bg-[#fafbfc] last:mb-0">
      <div className="flex items-center justify-between border-b border-ink-200 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-ink-500">
        <span>{lang || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-500 transition hover:bg-white hover:text-ink-900"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {error ? (
        <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-relaxed text-red-600 scroll-thin">
          {code}
        </pre>
      ) : html ? (
        <div className="shiki-container scroll-thin overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          highlighting…
        </div>
      )}
    </div>
  )
})

// — mermaid lazy renderer —
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        themeVariables: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '13px',
          primaryColor: '#ede9fe',
          primaryTextColor: '#1e1b4b',
          primaryBorderColor: '#a78bfa',
          lineColor: '#94a3b8',
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
        const m = await getMermaid()
        // mermaid throws if syntax invalid; catch and surface
        const { svg } = await m.render(`m${id}`, code)
        if (alive) setSvg(svg)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [code, id])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-violet-200 bg-violet-50/30 last:mb-0">
      <div className="flex items-center justify-between border-b border-violet-200 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-violet-700">
        <span>mermaid</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 transition',
            'text-violet-600 hover:bg-white hover:text-violet-900',
          )}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {error ? (
        <div className="space-y-1 p-2.5">
          <div className="text-[11px] font-medium text-red-600">Mermaid 渲染失败</div>
          <pre className="overflow-x-auto rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 scroll-thin">
            {error}
          </pre>
          <pre className="overflow-x-auto rounded bg-white px-2 py-1 text-[11px] text-ink-700 scroll-thin">
            {code}
          </pre>
        </div>
      ) : svg ? (
        <div className="overflow-x-auto p-3 [&>svg]:mx-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-ink-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          rendering diagram…
        </div>
      )}
    </div>
  )
})
