import { Button, cn } from '@edgevault/ui'
import type { ComponentProps } from 'react'

/**
 * Vendored from AI Elements (ai-sdk.dev), rewired to @edgevault/ui's Button +
 * native horizontal scroll (no shadcn scroll-area). Starter prompts that send
 * on click.
 */
export type SuggestionsProps = ComponentProps<'div'>

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <div
    className={cn(
      'flex w-full flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string
  onClick?: (suggestion: string) => void
}

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  children,
  ...props
}: SuggestionProps) => (
  <Button
    type="button"
    variant="secondary"
    size="compact"
    onClick={() => onClick?.(suggestion)}
    className={cn('shrink-0 font-mono', className)}
    {...props}
  >
    {children || suggestion}
  </Button>
)
