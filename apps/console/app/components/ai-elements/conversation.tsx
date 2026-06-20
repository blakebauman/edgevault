import { Button, cn } from '@edgevault/ui'
import { type ComponentProps, useCallback } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

/**
 * Vendored from AI Elements (ai-sdk.dev), rewired to @edgevault/ui's cn + Button
 * so it inherits the vault theme. Auto-scrolls to the latest message and offers
 * a jump-to-latest control when you've scrolled up.
 */
export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-auto', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
)

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-4 p-4', className)} {...props} />
)

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const handleScrollToBottom = useCallback(() => scrollToBottom(), [scrollToBottom])

  return isAtBottom ? null : (
    <Button
      variant="secondary"
      size="compact"
      type="button"
      onClick={handleScrollToBottom}
      className={cn('absolute bottom-3 left-1/2 -translate-x-1/2 font-mono', className)}
      {...props}
    >
      ↓ Latest
    </Button>
  )
}
