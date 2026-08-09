import { Button } from '@edgevault/ui'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

/**
 * The interactive button states added for action feedback: a spinner that locks
 * the button while keeping its label, and a one-shot success ring that fires
 * only when an action completes (successKey changes), never on first paint.
 */
describe('Button action states', () => {
  it('keeps the label and locks the button while loading', () => {
    render(
      <Button loading type="submit">
        Save new version
      </Button>,
    )
    const button = screen.getByRole('button', { name: /save new version/i })
    // Label is preserved (not swapped for "Saving…"), so its width is stable.
    expect(button).toHaveTextContent('Save new version')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('is not busy and not disabled when idle', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('does not fire the success ring on first paint', () => {
    render(<Button successKey="key@1">Save</Button>)
    expect(screen.getByRole('button')).not.toHaveClass('ev-success-pulse')
  })

  it('fires the success ring only when successKey changes', () => {
    const { rerender } = render(<Button successKey="key@1">Save</Button>)
    const button = screen.getByRole('button')
    expect(button).not.toHaveClass('ev-success-pulse')

    rerender(<Button successKey="key@2">Save</Button>)
    expect(button).toHaveClass('ev-success-pulse')
  })
})

/**
 * The spinner must not change the button's width. An inline spinner widened the
 * button ~18px on submit, which pushed the sign-in form's `flex-wrap` row past
 * its container and dropped "New here? Create an account" onto a new line
 * mid-submit (measured: 313px of content in a 318px row → 331px while loading).
 *
 * happy-dom does no layout, so these assert the structural properties that make
 * the width stable rather than measuring pixels.
 */
describe('Button loading is layout-neutral', () => {
  it('overlays the spinner instead of inserting it inline', () => {
    const { container } = render(<Button loading>Sign in</Button>)
    const button = container.querySelector('button')

    // Positioned overlay, so the spinner contributes no layout width.
    expect(button).toHaveClass('relative')
    const overlay = container.querySelector('.absolute')
    expect(overlay).not.toBeNull()
    expect(overlay?.className).toContain('inset-0')
  })

  it('keeps the label box so the width is unchanged, and keeps it readable', () => {
    const { container } = render(<Button loading>Sign in</Button>)

    const label = container.querySelector('span.opacity-0')
    expect(label).not.toBeNull()
    expect(label).toHaveTextContent('Sign in')
    // `invisible`/`hidden` would drop the label from the accessibility tree and
    // (for `hidden`) from layout — opacity-0 keeps both.
    expect(label?.className).not.toContain('invisible')
    expect(label?.className).not.toContain('hidden')
    // Mirrors the button's own flex gap so multi-child labels measure the same.
    expect(label?.className).toContain('gap-1.5')
  })

  it('still exposes the accessible name while busy', () => {
    render(<Button loading>Sign in</Button>)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })

  it('adds no positioning wrapper when idle', () => {
    const { container } = render(<Button>Sign in</Button>)
    expect(container.querySelector('button')).not.toHaveClass('relative')
    expect(container.querySelector('.absolute')).toBeNull()
    expect(container.querySelector('span.opacity-0')).toBeNull()
  })
})
