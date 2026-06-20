import { cn } from '@edgevault/ui'
import { type ComponentProps, memo } from 'react'
import { Streamdown } from 'streamdown'

/**
 * Vendored from AI Elements (ai-sdk.dev): markdown rendering via streamdown, so
 * assistant answers can carry lists, code, and links. Styled by `.ev-response`
 * in app.css to match the vault theme (no prose plugin needed). Lazy-loaded by
 * the assistant so streamdown stays out of the main/SSR bundle.
 */
export type ResponseProps = ComponentProps<typeof Streamdown>

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown className={cn('ev-response', className)} {...props} />
  ),
  (prev, next) => prev.children === next.children,
)

Response.displayName = 'Response'
