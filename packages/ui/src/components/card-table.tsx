import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The brand's data table: mono uppercase headers, hairline rules — and below
 * 640px it collapses into stacked cards (via .cards-sm in primitives.css) so
 * every action stays reachable on a phone. The wrapper is a labeled, focusable
 * scroll region for keyboard users at in-between widths.
 *
 * `stickyHeader` bounds the table's own height and pins the header row inside
 * it. Use it only where the row count is genuinely unbounded (audit history,
 * a large roster) — it introduces a nested scroller, which is worth a column
 * label you can still read at row 300 and not much else.
 */
function CardTable({
  label,
  className,
  stickyHeader = false,
  maxHeight = '70vh',
  children,
  ...props
}: React.ComponentProps<'table'> & {
  label: string
  stickyHeader?: boolean
  maxHeight?: string
}) {
  return (
    <section
      className={cn('overflow-x-auto', stickyHeader && 'overflow-y-auto')}
      style={stickyHeader ? { maxHeight } : undefined}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern)
      tabIndex={0}
    >
      <table
        data-sticky-header={stickyHeader || undefined}
        className={cn('cards-sm w-full border-collapse text-sm', className)}
        {...props}
      >
        {children}
      </table>
    </section>
  )
}

/**
 * Header cell. Pass `sort` to mark a sortable column: it sets `aria-sort` and
 * renders the direction caret. Navigation is the caller's job — the console
 * wraps the children in a router `<Link>`, the Astro site uses a plain anchor —
 * so this package stays framework-free.
 */
function Th({
  className,
  sort,
  children,
  ...props
}: React.ComponentProps<'th'> & { sort?: 'asc' | 'desc' | 'none' }) {
  return (
    <th
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
      // The pinned-header rule lives in primitives.css, keyed off the table's
      // data-sticky-header — an ancestor selector reads better as CSS than as
      // a stack of arbitrary variants.
      className={cn(
        'border-b border-border px-3 py-2 text-left font-mono text-xs font-normal uppercase tracking-widest text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
      {sort && sort !== 'none' && (
        <span aria-hidden="true" className="ml-1 text-accent">
          {sort === 'asc' ? '↑' : '↓'}
        </span>
      )}
    </th>
  )
}

/**
 * Body cell; `label` becomes the cell's own header in stacked-card mode.
 * Numerals are tabular throughout — DESIGN.md's Tabular Rule: numbers are
 * data, so they align down the column.
 */
function Td({ label, className, ...props }: React.ComponentProps<'td'> & { label?: string }) {
  return (
    <td
      data-label={label}
      className={cn('tabular-figures border-b border-border px-3 py-2 text-left', className)}
      {...props}
    />
  )
}

export { CardTable, Td, Th }
