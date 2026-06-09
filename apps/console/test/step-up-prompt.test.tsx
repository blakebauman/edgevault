import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StepUpPrompt } from '../app/components/step-up-prompt'
import { stepUpWithPasskey, stepUpWithTotp } from '../app/lib/passkey'

// The prompt drives the WebAuthn/TOTP ceremonies through these helpers; mock
// them so the test never touches the network or the WebAuthn API.
vi.mock('../app/lib/passkey', () => ({
  stepUpWithPasskey: vi.fn(),
  stepUpWithTotp: vi.fn(),
}))

const mockPasskey = vi.mocked(stepUpWithPasskey)
const mockTotp = vi.mocked(stepUpWithTotp)

beforeEach(() => {
  mockPasskey.mockReset()
  mockTotp.mockReset()
})

describe('StepUpPrompt', () => {
  it('verifies with a passkey and reports success', async () => {
    mockPasskey.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    render(
      <StepUpPrompt
        secretKey="db.password"
        workspaceId="ws-1"
        onSuccess={onSuccess}
        onCancel={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /verify with passkey/i }))

    expect(mockPasskey).toHaveBeenCalledOnce()
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
  })

  it('surfaces a failed check and does not report success', async () => {
    mockPasskey.mockResolvedValue({
      ok: false,
      error: 'No matching passkey, or verification failed.',
    })
    const onSuccess = vi.fn()
    render(
      <StepUpPrompt
        secretKey="db.password"
        workspaceId="ws-1"
        onSuccess={onSuccess}
        onCancel={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /verify with passkey/i }))

    expect(await screen.findByText(/no matching passkey/i)).toBeInTheDocument()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('falls back to an authenticator code', async () => {
    mockTotp.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    render(
      <StepUpPrompt
        secretKey="db.password"
        workspaceId="ws-1"
        onSuccess={onSuccess}
        onCancel={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /use authenticator code/i }))
    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(mockTotp).toHaveBeenCalledWith('123456', 'ws-1')
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
  })

  it('cancels', async () => {
    const onCancel = vi.fn()
    render(
      <StepUpPrompt
        secretKey="db.password"
        workspaceId="ws-1"
        onSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
