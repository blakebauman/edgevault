import { cn } from '@edgevault/ui'
import { type ComponentProps, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown rendering for assistant answers (lists, code, links). Adapted from
 * AI Elements' Response, but on react-markdown + remark-gfm rather than
 * streamdown — the agent emits prose, not diagrams or highlighted code, so we
 * skip streamdown's mermaid/shiki/katex weight. react-markdown renders no raw
 * HTML by default (safe); styling comes from `.ev-response` in app.css.
 */
export type ResponseProps = Omit<ComponentProps<'div'>, 'children'> & {
  children: string
}

export const Response = memo(
  ({ className, children, ...props }: ResponseProps) => (
    <div className={cn('ev-response', className)} {...props}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // External links open safely; internal styling is handled by .ev-response.
          a: ({ node: _node, ...a }) => (
            <a {...a} rel="noopener noreferrer" target="_blank">
              {a.children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  ),
  (prev, next) => prev.children === next.children,
)

Response.displayName = 'Response'
