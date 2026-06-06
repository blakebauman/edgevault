import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * An unsealed artifact: a revealed secret or a shown-once key. Wears the
 * dog-ear (the brand's "opened" mark) and sits on the deep Vault surface.
 */
function TokenBox({
  note,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { note: React.ReactNode }) {
  return (
    <div
      className={cn(
        'dog-ear rounded-sm border border-rollout bg-surface-2 p-4 [--fold-color:var(--rollout)]',
        className,
      )}
      {...props}
    >
      <p className="mb-2.5 mt-0 text-sm text-muted-foreground">{note}</p>
      <div className="flex items-stretch gap-2">{children}</div>
    </div>
  )
}

/** The value itself — mono, Plaintext Lilac, selectable. */
function TokenValue({ className, ...props }: React.ComponentProps<'code'>) {
  return (
    <code
      className={cn(
        'block flex-1 break-all rounded-sm bg-black/35 px-3 py-2.5 font-mono text-sm text-plaintext',
        className,
      )}
      {...props}
    />
  )
}

export { TokenBox, TokenValue }
