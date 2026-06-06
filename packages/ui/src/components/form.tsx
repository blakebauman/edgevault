import type * as React from 'react'
import { cn } from '../lib/cn'

/** Text input in the brand's machined register. */
function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'rounded-sm border border-input bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'resize-y rounded-sm border border-input bg-card px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    />
  )
}

/** Native select with the machined chevron (no JS, no portal). */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'chevron-select rounded-sm border border-input bg-card px-3 py-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    />
  )
}

function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" className={cn('size-4 accent-relay', className)} {...props} />
}

/** A labeled field: the label text above its control, in the muted voice. */
function Field({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<'label'> & { label: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`; the static analyzer can't see through the prop
    <label
      className={cn('flex flex-col gap-1.5 text-sm text-muted-foreground', className)}
      {...props}
    >
      {label}
      {children}
    </label>
  )
}

/** Inline outcome line under a form or table — polite, announced. */
function StatusNote({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p role="status" className={cn('m-0 text-sm text-muted-foreground', className)} {...props} />
  )
}

/** Inline error line — assertive, in the danger voice. */
function ErrorNote({ className, ...props }: React.ComponentProps<'p'>) {
  return <p role="alert" className={cn('m-0 text-sm text-destructive', className)} {...props} />
}

export { Checkbox, ErrorNote, Field, Input, Select, StatusNote, Textarea }
