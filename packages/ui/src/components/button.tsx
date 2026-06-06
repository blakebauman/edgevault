import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The brand's three button voices plus the danger voice:
 *  - default: filled (Relay violet in the vault register, Ledger ink on light)
 *  - secondary: line voice — transparent with the accent
 *  - danger: irreversible confirms only; never brand-positive
 *  - linklike: text that acts
 */
const buttonVariants = cva(
  'm-0 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border font-display font-medium no-underline transition-colors disabled:cursor-default disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground hover:bg-rollout hover:border-rollout disabled:hover:bg-primary disabled:hover:border-primary',
        secondary:
          'border-primary bg-transparent text-accent hover:bg-relay/18 hover:text-plaintext',
        danger: 'border-destructive bg-transparent text-destructive hover:bg-destructive/16',
        linklike:
          'm-0 border-none bg-transparent p-0 font-sans font-normal text-muted-foreground hover:text-accent',
      },
      size: {
        default: 'px-4 py-2 text-sm',
        compact: 'px-3 py-1.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { Button, buttonVariants }
