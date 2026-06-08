import type { InvitationEmailJob } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import { buildInvitationEmail, sendInvitationEmail } from '../src/email'

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
