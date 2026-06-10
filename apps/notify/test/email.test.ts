import type { InvitationEmailJob } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  buildInvitationEmail,
  buildPasswordResetEmail,
  buildSignupExistsEmail,
  buildVerificationEmail,
  sendEmail,
  sendInvitationEmail,
} from '../src/email'

const job: InvitationEmailJob = {
  kind: 'invitation-email',
  to: 'newcomer@example.com',
  organizationName: 'Acme & Sons',
  inviterName: 'Ada Lovelace',
  role: 'member',
  acceptUrl: 'https://app.test/invite/11111111-2222-3333-4444-555555555555',
  expiresAt: Date.UTC(2026, 5, 13, 12, 0, 0),
}

describe('invitation email', () => {
  it('renders inviter, org, role, link, and expiry in both bodies', () => {
    const { subject, html, text } = buildInvitationEmail(job)
    expect(subject).toBe('Ada Lovelace invited you to Acme & Sons on EdgeVault')
    for (const body of [html, text]) {
      expect(body).toContain(job.acceptUrl)
      expect(body).toContain('member')
      expect(body).toContain('13 Jun 2026')
      expect(body).toContain('newcomer@example.com')
    }
  })

  it('escapes HTML in attacker-influenced fields (inviter and org names)', () => {
    const { html, text } = buildInvitationEmail({
      ...job,
      organizationName: '<img src=x onerror=alert(1)>',
      inviterName: 'Eve "</a>" Mallory',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Eve &quot;&lt;/a&gt;&quot; Mallory')
    // Plain text body needs no escaping.
    expect(text).toContain('<img src=x onerror=alert(1)>')
  })

  it('sends from noreply@edgevault.io with both html and text parts', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' }))
    await sendInvitationEmail({ send }, job)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'newcomer@example.com',
        from: { email: 'noreply@edgevault.io', name: 'EdgeVault' },
        html: expect.stringContaining(job.acceptUrl),
        text: expect.stringContaining(job.acceptUrl),
      }),
    )
  })
})

describe('account-lifecycle emails', () => {
  const expiresAt = Date.UTC(2026, 5, 13, 12, 0, 0)

  it('verification email carries the link and expiry in both bodies', () => {
    const { subject, html, text } = buildVerificationEmail({
      kind: 'verification-email',
      to: 'new@example.com',
      verifyUrl: 'https://app.test/verify-email?token=tok123',
      expiresAt,
    })
    expect(subject).toContain('Verify')
    for (const body of [html, text]) {
      expect(body).toContain('https://app.test/verify-email?token=tok123')
      expect(body).toContain('13 Jun 2026')
    }
  })

  it('password-reset email carries the link and says it signs out everywhere', () => {
    const { html, text } = buildPasswordResetEmail({
      kind: 'password-reset-email',
      to: 'user@example.com',
      resetUrl: 'https://app.test/reset-password?token=tok456',
      expiresAt,
    })
    for (const body of [html, text]) {
      expect(body).toContain('https://app.test/reset-password?token=tok456')
      expect(body).toContain('signs you out everywhere')
    }
  })

  it('signup-exists email offers sign-in and reset, never confirms to the requester', () => {
    const { html, text } = buildSignupExistsEmail({
      kind: 'signup-exists-email',
      to: 'existing@example.com',
      signInUrl: 'https://app.test/login',
      resetUrl: 'https://app.test/forgot-password',
    })
    for (const body of [html, text]) {
      expect(body).toContain('https://app.test/login')
      expect(body).toContain('https://app.test/forgot-password')
    }
  })

  it('sendEmail routes every kind through the sender', async () => {
    const send = vi.fn(async () => ({}))
    await sendEmail(
      { send },
      {
        kind: 'verification-email',
        to: 'new@example.com',
        verifyUrl: 'https://app.test/verify-email?token=t',
        expiresAt,
      },
    )
    await sendEmail({ send }, job)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: 'new@example.com',
        subject: expect.stringContaining('Verify'),
      }),
    )
  })
})
