import type { InvitationEmailJob } from '@edgevault/edge-protocol'

/**
 * Invitation email rendering + send. The sender is the `send_email` binding,
 * typed structurally so tests can inject a fake without the binding existing
 * in the test runtime.
 */

export interface EmailSender {
  send(message: {
    to: string
    from: { email: string; name: string }
    subject: string
    html: string
    text: string
  }): Promise<unknown>
}

const FROM = { email: 'noreply@edgevault.io', name: 'EdgeVault' }

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildInvitationEmail(job: InvitationEmailJob): {
  subject: string
  html: string
  text: string
} {
  const expires = new Date(job.expiresAt).toUTCString()
  const subject = `${job.inviterName} invited you to ${job.organizationName} on EdgeVault`
  // Plainspoken, text-first — the brand voice. No imagery, one link.
  const text = [
    `${job.inviterName} invited you to join ${job.organizationName} on EdgeVault as ${job.role}.`,
    '',
    'EdgeVault is edge-native configuration, secrets, and feature-flag management.',
    '',
    `Accept the invitation (create your account with this email address):`,
    job.acceptUrl,
    '',
    `This link works until ${expires} and only for ${job.to}.`,
    `If you weren't expecting this, ignore it — nothing happens without you.`,
  ].join('\n')
  const html = [
    '<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 0 auto; color: #0f172a;">',
    `<p><strong>${escapeHtml(job.inviterName)}</strong> invited you to join <strong>${escapeHtml(job.organizationName)}</strong> on EdgeVault as <strong>${escapeHtml(job.role)}</strong>.</p>`,
    '<p>EdgeVault is edge-native configuration, secrets, and feature-flag management.</p>',
    `<p><a href="${escapeHtml(job.acceptUrl)}" style="display: inline-block; padding: 0.6rem 1.2rem; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 2px;">Accept invitation</a></p>`,
    `<p style="color: #475569; font-size: 0.875rem;">Or paste this link into your browser:<br>${escapeHtml(job.acceptUrl)}</p>`,
    `<p style="color: #475569; font-size: 0.875rem;">This link works until ${expires} and only for ${escapeHtml(job.to)}. If you weren't expecting this, ignore it — nothing happens without you.</p>`,
    '</div>',
  ].join('\n')
  return { subject, html, text }
}

export async function sendInvitationEmail(
  sender: EmailSender,
  job: InvitationEmailJob,
): Promise<void> {
  const { subject, html, text } = buildInvitationEmail(job)
  await sender.send({ to: job.to, from: FROM, subject, html, text })
}
