import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../lib/cn'

/**
 * The brand's three button voices plus the danger voice:
 *  - default: filled (Relay violet in the vault register, Ledger ink on light)
 *  - secondary: line voice — transparent with the accent
 *  - danger: irreversible confirms only; never brand-positive
 *  - linklike: text that acts
 *
 * Interaction: a 1px press nudge on the framed voices (instant under reduced
 * motion), an in-button spinner while `loading` (the label stays put), and a
 * one-shot --ok ring when `successKey` changes after a completed action.
 */
const buttonVariants = cva(
  'm-0 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border font-display font-medium no-underline transition-[color,background-color,border-color,transform] active:translate-y-px motion-reduce:active:translate-y-0 disabled:cursor-default disabled:opacity-55 aria-busy:cursor-progress focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground hover:bg-rollout hover:border-rollout disabled:hover:bg-primary disabled:hover:border-primary',
        secondary:
          'border-input bg-transparent text-foreground/85 hover:border-accent hover:bg-transparent hover:text-accent',
        danger: 'border-destructive bg-transparent text-destructive hover:bg-destructive/16',
        linklike:
          'm-0 border-none bg-transparent p-0 font-sans font-normal text-muted-foreground hover:text-accent active:translate-y-0',
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

/** Inline busy indicator. A static ring under reduced motion (the disabled
 * state + unchanged label already say "working"); spins otherwise. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-[0.85em] shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none motion-reduce:border-r-current motion-reduce:opacity-70"
    />
  )
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  successKey,
  disabled,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Show the spinner and lock the button while an action is in flight. */
    loading?: boolean
    /** Change this after a completed action to fire a one-shot --ok ring. */
    successKey?: string | number
  }) {
  const Comp = asChild ? Slot : 'button'
  const [pulsing, setPulsing] = React.useState(false)
  const prevKey = React.useRef(successKey)

  React.useEffect(() => {
    if (successKey !== undefined && successKey !== prevKey.current) setPulsing(true)
    prevKey.current = successKey
  }, [successKey])

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), pulsing && 'ev-success-pulse', className)}
      // Slot forwards to its single child; an <a> has no disabled, so only the
      // real <button> takes disabled/aria-busy/spinner.
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={!asChild && loading ? true : undefined}
      onAnimationEnd={() => setPulsing(false)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Spinner />}
          {children}
        </>
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
