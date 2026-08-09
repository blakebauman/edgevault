import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The empty state, in one shape.
 *
 * Five hand-rolled variants of this existed across the console, drifting in
 * padding and alignment. More importantly they mostly said "nothing here",
 * which wastes the one screen a new admin is guaranteed to see. An empty
 * surface is the cheapest place to explain what the surface is for, so `title`
 * names the absence and `children` teaches the mechanism.
 *
 * `action` is optional and belongs only where the reader can actually act —
 * a member looking at an empty SSO page can't configure it, and a dead button
 * is worse than none.
 */
function EmptyState({
  title,
  action,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { title: string; action?: React.ReactNode }) {
  return (
    <div className={cn('px-4 py-10 text-center', className)} {...props}>
      <p className="m-0 font-display font-medium text-foreground">{title}</p>
      {children && (
        <div className="mx-auto mt-2 max-w-md text-pretty text-sm text-muted-foreground">
          {children}
        </div>
      )}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * The same block inside a table body, spanning every column — the shape most
 * of the console's lists need, so callers don't hand-roll the colSpan row.
 */
function EmptyRow({
  colSpan,
  title,
  action,
  children,
}: {
  colSpan: number
  title: string
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="border-b border-border">
        <EmptyState title={title} action={action}>
          {children}
        </EmptyState>
      </td>
    </tr>
  )
}

export { EmptyRow, EmptyState }
