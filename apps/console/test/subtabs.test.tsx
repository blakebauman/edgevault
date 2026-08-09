import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Subtabs } from '../app/components/items'

/**
 * `Subtabs` declares role="tablist", which promises keyboard behaviour that it
 * did not implement: every tab was a tab stop and the arrow keys did nothing.
 * Screen readers announce "tab, 1 of 3" and users then press Left/Right — a
 * WCAG 2.1.1 failure when nothing moves. These pin the APG contract.
 */

const TABS = [
  { id: 'value', label: 'Value' },
  { id: 'history', label: 'History' },
  { id: 'across', label: 'Across' },
]

function Harness() {
  const [active, setActive] = useState('value')
  return <Subtabs tabs={TABS} active={active} onChange={setActive} />
}

describe('Subtabs', () => {
  it('exposes one tab stop (roving tabindex), not one per tab', () => {
    render(<Harness />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('moves selection and focus with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Value' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    const history = screen.getByRole('tab', { name: 'History' })
    expect(history).toHaveFocus()
    expect(history).toHaveAttribute('aria-selected', 'true')

    // Left from the first tab wraps to the last, per the APG.
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Across' })).toHaveFocus()
  })

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.tab()
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Across' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Value' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the tablist a single stop when tabbing past it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Harness />
        <button type="button">After</button>
      </>,
    )
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Value' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })
})
