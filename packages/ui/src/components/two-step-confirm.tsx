import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { Button } from './button'

/**
 * The arm → confirm pattern for irreversible actions (delete, revert, promote,
 * approve). Arming replaces the WHOLE action group at the same height so
 * nothing shifts at the moment of the dangerous click — and the confirm never
 * renders where the trigger was, so a double-click can't fall through.
 *
 * The confirm itself is supplied by the caller (typically a react-router
 * <Form> ending in a danger Button) so this package stays router-agnostic.
 */
function TwoStepConfirm({
  trigger,
  note,
  disabled,
  className,
  children,
}: {
  /** Label for the arming button (the safe first click). */
  trigger: ReactNode
  /** What is about to happen, in the warning voice. */
  note: ReactNode
  disabled?: boolean
  className?: string
  /** Render the confirm control; call `close` on submit/cancelled. */
  children: (close: () => void) => ReactNode
}) {
  const [arming, setArming] = useState(false)
  const armedRef = useRef<HTMLDivElement>(null)

  // Keyboard/SR users armed this — move focus to the confirm control so the
  // warning (an alert region) is announced and the next Tab isn't a mystery.
  useEffect(() => {
    if (arming) armedRef.current?.querySelector('button')?.focus()
  }, [arming])

  if (!arming) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="compact"
        disabled={disabled}
        onClick={() => setArming(true)}
      >
        {trigger}
      </Button>
    )
  }

  return (
    <div
      ref={armedRef}
      className={cn('flex min-h-8 flex-nowrap items-center gap-2 max-sm:flex-wrap', className)}
    >
      <p className="m-0 text-xs text-warn" role="alert">
        {note}
      </p>
      {children(() => setArming(false))}
      <Button type="button" variant="secondary" size="compact" onClick={() => setArming(false)}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * A row of actions that wraps rather than forcing its container wider.
 *
 * This used to be `flex-nowrap` above the small breakpoint, so a row of four
 * item actions set a min-content width the column could not honour: in the
 * list + detail split the items table needed 720px inside a 661px column,
 * overflowed, and clipped the last button. Horizontal scrolling to reach
 * Delete is not a real affordance, and the wrap costs nothing when there is
 * room, because the group only takes a second line once it genuinely runs out.
 */
function ActionGroup({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-h-8 flex-wrap items-center gap-2', className)}>{children}</div>
  )
}

export { ActionGroup, TwoStepConfirm }
