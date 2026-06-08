import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from '../app/components/copy-button'

/**
 * The security-relevant behavior is the clipboard auto-clear: it must wipe the
 * clipboard after the delay, but ONLY if the clipboard still holds the value we
 * wrote — never clobbering something the user copied since.
 */

let clip = ''
const writeText = vi.fn(async (t: string) => {
  clip = t
})
const readText = vi.fn(async () => clip)

beforeEach(() => {
  clip = ''
  writeText.mockClear()
  readText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CopyButton', () => {
  it('copies the value and shows confirmation', async () => {
    render(<CopyButton value="s3cr3t" label="Copy value" />)
    await userEvent.click(screen.getByRole('button'))
    expect(writeText).toHaveBeenCalledWith('s3cr3t')
    expect(await screen.findByText('Copied ✓')).toBeInTheDocument()
  })

  it('clears the clipboard after the delay when it still holds our value', async () => {
    vi.useFakeTimers()
    render(<CopyButton value="s3cr3t" label="Copy value" clearAfterMs={30_000} />)
    fireEvent.click(screen.getByRole('button'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(clip).toBe('s3cr3t')

    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(writeText).toHaveBeenLastCalledWith('')
    expect(clip).toBe('')
    expect(screen.getByRole('button')).toHaveTextContent('Clipboard cleared')
  })

  it('does NOT clear when the user has copied something else since', async () => {
    vi.useFakeTimers()
    render(<CopyButton value="s3cr3t" label="Copy value" clearAfterMs={30_000} />)
    fireEvent.click(screen.getByRole('button'))
    await act(() => vi.advanceTimersByTimeAsync(0))

    // User copies something unrelated before the timer fires.
    clip = 'unrelated clipboard content'
    await act(() => vi.advanceTimersByTimeAsync(30_000))

    expect(writeText).not.toHaveBeenCalledWith('')
    expect(clip).toBe('unrelated clipboard content')
    expect(screen.getByRole('button')).not.toHaveTextContent('Clipboard cleared')
  })
})
