import type * as React from 'react'
import { cn } from '../lib/cn'
import { Td } from './card-table'

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

/**
 * `rows` × `columns` of skeleton cells sized to a `CardTable` body, so the
 * table doesn't reflow when the real rows arrive. Widths vary per column to
 * avoid the uncanny grid of identical bars.
 */
function SkeletonRows({
  rows = 5,
  columns = 4,
  label = 'Loading…',
}: {
  rows?: number
  columns?: number
  label?: string
}) {
  const widths = ['w-28', 'w-40', 'w-20', 'w-32', 'w-24']
  const grid = Array.from({ length: rows }, (_, r) => ({
    id: `r${r}`,
    cells: Array.from({ length: columns }, (_, c) => ({
      id: `r${r}c${c}`,
      width: widths[c % widths.length],
    })),
  }))
  return (
    <>
      {grid.map((row) => (
        <tr key={row.id}>
          {row.cells.map((cell) => (
            <Td key={cell.id}>
              <Skeleton className={cell.width} />
            </Td>
          ))}
        </tr>
      ))}
      <tr>
        <td colSpan={columns} className="sr-only" role="status">
          {label}
        </td>
      </tr>
    </>
  )
}

export { Skeleton, SkeletonRows }
