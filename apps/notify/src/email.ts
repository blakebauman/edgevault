import type {
  EmailJob,
  InvitationEmailJob,
  PasswordResetEmailJob,
  SignupExistsEmailJob,
  VerificationEmailJob,
} from '@edgevault/edge-protocol'

/**
 * Transactional email rendering + send. The sender is the `send_email` binding,
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

/** Shared shell for the short account-lifecycle emails: one message, one link. */
function buildLinkEmail(input: {
  subject: string
  intro: string
  cta: string
  url: string
  outro: string
}): { subject: string; html: string; text: string } {
  const text = [input.intro, '', `${input.cta}:`, input.url, '', input.outro].join('\n')
  const html = [
    '<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 0 auto; color: #0f172a;">',
    `<p>${escapeHtml(input.intro)}</p>`,
    `<p><a href="${escapeHtml(input.url)}" style="display: inline-block; padding: 0.6rem 1.2rem; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 2px;">${escapeHtml(input.cta)}</a></p>`,
    `<p style="color: #475569; font-size: 0.875rem;">Or paste this link into your browser:<br>${escapeHtml(input.url)}</p>`,
    `<p style="color: #475569; font-size: 0.875rem;">${escapeHtml(input.outro)}</p>`,
    '</div>',
  ].join('\n')
  return { subject: input.subject, html, text }
}

export function buildVerificationEmail(job: VerificationEmailJob): {
  subject: string
  html: string
  text: string
} {
  return buildLinkEmail({
    subject: 'Verify your email for EdgeVault',
    intro: 'Confirm this address to finish setting up your EdgeVault account.',
    cta: 'Verify email',
    url: job.verifyUrl,
    outro: `This link works until ${new Date(job.expiresAt).toUTCString()} and only for ${job.to}. If you didn't create an account, ignore this — nothing happens without you.`,
  })
}

export function buildPasswordResetEmail(job: PasswordResetEmailJob): {
  subject: string
  html: string
  text: string
} {
  return buildLinkEmail({
    subject: 'Reset your EdgeVault password',
    intro: 'Someone asked to reset the password for this EdgeVault account.',
    cta: 'Reset password',
    url: job.resetUrl,
    outro: `This link works until ${new Date(job.expiresAt).toUTCString()}. Using it signs you out everywhere. If this wasn't you, ignore it — your password stays as it is.`,
  })
}

export function buildSignupExistsEmail(job: SignupExistsEmailJob): {
  subject: string
  html: string
  text: string
} {
  const text = [
    'Someone just tried to create an EdgeVault account with this email address — but you already have one.',
    '',
    `If that was you, sign in instead: ${job.signInUrl}`,
    `Forgot your password? Reset it: ${job.resetUrl}`,
    '',
    "If it wasn't you, no action is needed — no account was created and nothing changed.",
  ].join('\n')
  const html = [
    '<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 0 auto; color: #0f172a;">',
    '<p>Someone just tried to create an EdgeVault account with this email address — but you already have one.</p>',
    `<p>If that was you, <a href="${escapeHtml(job.signInUrl)}">sign in instead</a>. Forgot your password? <a href="${escapeHtml(job.resetUrl)}">Reset it</a>.</p>`,
    `<p style="color: #475569; font-size: 0.875rem;">If it wasn't you, no action is needed — no account was created and nothing changed.</p>`,
    '</div>',
  ].join('\n')
  return { subject: 'You already have an EdgeVault account', html, text }
}

/** Render + send any transactional email job (routed by `kind`). */
export async function sendEmail(sender: EmailSender, job: EmailJob): Promise<void> {
  const message =
    job.kind === 'invitation-email'
      ? buildInvitationEmail(job)
      : job.kind === 'verification-email'
        ? buildVerificationEmail(job)
        : job.kind === 'password-reset-email'
          ? buildPasswordResetEmail(job)
          : buildSignupExistsEmail(job)
  await sender.send({ to: job.to, from: FROM, ...message })
}
