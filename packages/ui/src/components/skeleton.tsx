import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * Loading placeholders that hold the shape of what's coming.
 *
 * The console's global treatment (a delayed progress bar plus dimming the
 * content area) is right for a route change that lands in a few hundred ms.
 * It is wrong for a query that scans R2 day partitions, where the page sits
 * dimmed and empty long enough to read as broken. Those surfaces get rows.
 *
 * A skeleton is decoration to a screen reader, so the block is hidden from it;
 * announce the wait once at the container with `role="status"` instead of
 * letting twelve fake rows narrate themselves.
 */

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div aria-hidden="true" className={cn('ev-skeleton h-4', className)} {...props} />
}

export { Skeleton }
