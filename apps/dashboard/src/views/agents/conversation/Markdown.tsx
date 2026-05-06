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
 * Markdown renderer tuned to the Shujian palette.
 * - GFM (tables, task lists, autolinks)
 * - shiki syntax highlighting for fenced code (theme follows .light class)
 * - Mermaid diagrams (```mermaid)
 * - Streaming caret on the trailing block while assistant is typing
 */
export const Markdown = memo(function Markdown({ text, streaming, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        'md-prose break-words text-[13.5px] leading-[1.65] text-ink-muted',
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
              className="text-accent decoration-accent/40 underline underline-offset-[3px] transition-colors hover:text-accent-hi hover:decoration-accent"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-[15px] font-semibold text-ink first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[14px] font-semibold text-ink first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold text-ink first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-muted first:mt-0">
              {children}
            </h4>
          ),
          ul: ({ children }) => <ul className="mb-2 ml-5 list-disc space-y-0.5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-[1.65]">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 rounded-md bg-surface-2 px-3 py-2 text-ink-muted last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic text-ink">{children}</em>,
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-line px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line px-2.5 py-1.5 align-top text-ink last:border-b-0">
              {children}
            </td>
          ),
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = /\blanguage-/.test(codeClass ?? '')
            if (isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-ink">
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
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[14px] w-[2px] -translate-y-[1px] animate-stream-caret bg-accent align-middle"
        />
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
