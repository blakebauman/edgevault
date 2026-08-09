import type * as React from 'react'
import { cn } from '../lib/cn'

/**
 * A banner that carries one voice: info (accent), ok, warn, or danger.
 *
 * The console's `.attention` class was the warn-locked ancestor of this — same
 * tint idiom (`color-mix` onto `--card`), same flat 2px construction, but the
 * tone is a parameter so posture and policy surfaces can say "enforced" in the
 * same shape they say "not yet".
 *
 * `role` defaults to none: a callout describing steady state is prose, not an
 * announcement. Pass `role="alert"` only when it appears in response to an
 * action — otherwise every page load shouts at screen-reader users.
 */

const TONE_CLASS = {
  info: 'callout-tone-info',
  ok: 'callout-tone-ok',
  warn: 'callout-tone-warn',
  danger: 'callout-tone-danger',
} as const

export type CalloutTone = keyof typeof TONE_CLASS

const TONE_ICON: Record<CalloutTone, React.ReactNode> = {
  // Circle-i, circle-check, triangle-!, circle-x — one stroke weight, one box.
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
}

function Callout({
  tone = 'info',
  icon = true,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { tone?: CalloutTone; icon?: boolean }) {
  return (
    <div className={cn('callout', TONE_CLASS[tone], className)} {...props}>
      {icon && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {TONE_ICON[tone]}
        </svg>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export { Callout }
