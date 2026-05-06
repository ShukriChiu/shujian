import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock, MermaidBlock } from './CodeBlock'
import { cn } from '@/lib/utils'

interface MarkdownProps {
  text: string
  /** Show the streaming caret at the end of the text. */
  streaming?: boolean
  className?: string
}

/**
 * Cursor-style markdown renderer.
 * - GFM (tables, task lists, strikethrough, autolinks)
 * - shiki syntax-highlighting (VSCode `github-light` theme)
 * - Mermaid diagrams (```mermaid)
 * - Inline copy + language pill on every code block
 */
export const Markdown = memo(function Markdown({ text, streaming, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        'md-prose text-[13.5px] leading-relaxed text-ink-800 break-words',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-violet-700 underline decoration-violet-300 underline-offset-2 hover:decoration-violet-700"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-base font-bold text-ink-900 first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[15px] font-bold text-ink-900 first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2.5 text-[14px] font-semibold text-ink-900 first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 text-[13px] font-semibold text-ink-900 first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => <ul className="mb-2 ml-5 list-disc space-y-0.5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-violet-300 bg-violet-50/40 px-3 py-1.5 italic text-ink-600 last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-ink-200" />,
          strong: ({ children }) => <strong className="font-semibold text-ink-900">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto rounded-lg border border-ink-200">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-ink-50">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-ink-200 px-2.5 py-1.5 text-left font-semibold text-ink-700">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-ink-100 px-2.5 py-1.5 align-top text-ink-700 last:border-b-0">{children}</td>
          ),
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = /\blanguage-/.test(codeClass ?? '')
            if (isBlock) {
              // delegated to <pre> handler
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[0.85em] text-ink-800">
                {children}
              </code>
            )
          },
          pre: ({ children }) => {
            const codeEl = extractCodeElement(children)
            const codeText = elementText(codeEl).replace(/\n$/, '')
            const lang = extractLang(codeEl)
            if (lang === 'mermaid') return <MermaidBlock code={codeText} />
            return <CodeBlock code={codeText} lang={lang || 'plaintext'} />
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] -translate-y-[1px] animate-pulse-soft bg-violet-500 align-middle" />
      )}
    </div>
  )
})

function extractCodeElement(node: React.ReactNode): React.ReactElement | null {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const c of node) {
      const found = extractCodeElement(c)
      if (found) return found
    }
    return null
  }
  if (typeof node === 'object' && 'props' in (node as object)) {
    return node as React.ReactElement
  }
  return null
}

function elementText(el: React.ReactElement | null): string {
  if (!el) return ''
  const props = (el as { props?: { children?: React.ReactNode } }).props
  return childrenToString(props?.children)
}

function childrenToString(children: React.ReactNode): string {
  if (children == null || children === false) return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToString).join('')
  if (typeof children === 'object' && 'props' in (children as object)) {
    const props = (children as { props?: { children?: React.ReactNode } }).props
    return childrenToString(props?.children)
  }
  return ''
}

function extractLang(el: React.ReactElement | null): string {
  if (!el) return ''
  const props = (el as { props?: { className?: string } }).props
  const cls = props?.className ?? ''
  const m = cls.match(/language-([\w+-]+)/)
  return m?.[1] ?? ''
}
