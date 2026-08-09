import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The artifact panel: the product's own material, typeset rather than
 * screenshotted — a command you can run, a response you'd actually get.
 *
 * DESIGN.md §5 names this a signature component (Vault Depth ground, mono,
 * real output) and the brand's first principle is artifact-as-hero, but it
 * only existed as the dog-eared `TokenBox`. That variant means something
 * specific — "this was unsealed" — so using it for a copyable command would
 * spend the fold on nothing. This is the plain, sealed sibling.
 *
 * Contents must be real and syntactically valid. A fabricated command here is
 * the same failure as a fake dashboard screenshot.
 */
function ArtifactPanel({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { label?: React.ReactNode }) {
  return (
    <div className={cn('rounded-sm border border-border bg-vault p-4', className)} {...props}>
      {label && <p className="mb-2.5 mt-0 text-sm text-muted-foreground">{label}</p>}
      <pre className="m-0 overflow-x-auto font-mono text-xs leading-relaxed text-plaintext">
        {children}
      </pre>
    </div>
  )
}

export { ArtifactPanel }
