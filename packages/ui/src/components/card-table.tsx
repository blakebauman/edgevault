import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The brand's data table: mono uppercase headers, hairline rules — and below
 * 640px it collapses into stacked cards (via .cards-sm in primitives.css) so
 * every action stays reachable on a phone. The wrapper is a labeled, focusable
 * scroll region for keyboard users at in-between widths.
 */
function CardTable({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<'table'> & { label: string }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern)
    <section className="overflow-x-auto" aria-label={label} tabIndex={0}>
      <table className={cn('cards-sm w-full border-collapse text-sm', className)} {...props}>
        {children}
      </table>
    </section>
  )
}

function Th({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'border-b border-border px-3 py-2 text-left font-mono text-xs font-normal uppercase tracking-widest text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** Body cell; `label` becomes the cell's own header in stacked-card mode. */
function Td({ label, className, ...props }: React.ComponentProps<'td'> & { label?: string }) {
  return (
    <td
      data-label={label}
      className={cn('border-b border-border px-3 py-2 text-left', className)}
      {...props}
    />
  )
}

export { CardTable, Td, Th }
