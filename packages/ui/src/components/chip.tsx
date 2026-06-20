import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * Two chip families with distinct construction so their meanings can't blur:
 *  - kinds (what it is): tinted fills — config/flag/secret; secret wears the
 *    sealed corner
 *  - outcomes (how it went): outlines — ok/warn/danger
 *  - drift (how it compares): outlines in the compare vocabulary
 */
const chipVariants = cva(
  'inline-block rounded-sm border border-transparent px-2 py-0.5 font-mono text-xs',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-foreground',
        // The four kinds read as a set: config wears a neutral hairline (so it's
        // a chip, not bare text), flag is the loud accent, secret the sealed
        // lilac, content a faint accent fill with its own hairline.
        'kind-config': 'border-border bg-muted text-foreground',
        'kind-flag': 'bg-accent/16 text-accent',
        'kind-secret': 'sealed-corner bg-plaintext/14 text-plaintext',
        'kind-content': 'border-accent/30 bg-accent/10 text-foreground',
        ok: 'border-ok/40 text-ok',
        warn: 'border-warn/40 text-warn',
        danger: 'border-destructive/40 text-destructive',
        'drift-equal': 'border-ok/40 text-ok',
        'drift-drifted': 'border-warn/40 text-warn',
        'drift-only': 'border-accent/40 text-accent',
        'drift-not-comparable': 'border-input text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
)

type ChipVariant = NonNullable<VariantProps<typeof chipVariants>['variant']>

function Chip({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof chipVariants>) {
  return <span className={cn(chipVariants({ variant }), className)} {...props} />
}

export { Chip, type ChipVariant, chipVariants }
