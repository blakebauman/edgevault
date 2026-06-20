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
