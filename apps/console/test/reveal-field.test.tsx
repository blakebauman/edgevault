import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RevealField } from '../app/components/reveal-field'

// RevealField renders a CopyButton, which probes navigator.clipboard on mount.
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => '') },
    configurable: true,
  })
})

describe('RevealField', () => {
  it('masks the value by default and reveals it only on toggle', async () => {
    render(<RevealField secretKey="db.password" value="hunter2" onDismiss={() => {}} />)

    // Masked: the plaintext is not in the document until the user asks.
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show/i }))
    expect(screen.getByText('hunter2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /hide/i })).toBeInTheDocument()
  })

  it('re-masks when the window loses focus', () => {
    render(<RevealField secretKey="db.password" value="hunter2" onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /show/i }))
    expect(screen.getByText('hunter2')).toBeInTheDocument()

    // Alt-tab / screen-share / lock: the secret should not stay on screen.
    fireEvent.blur(window)
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument()
  })

  it('calls onDismiss when dismissed', () => {
    const onDismiss = vi.fn()
    render(<RevealField secretKey="db.password" value="hunter2" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
