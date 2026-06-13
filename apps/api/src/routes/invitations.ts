import { Hono } from 'hono'
import type { AppEnv } from '../context'

/**
 * Invitation accept surface (mounted under /api/v1/invitations, behind
 * requireAuth). Deliberately NOT org-scoped — the caller isn't a member yet.
 * Every response is bound to the signed-in user's email: a leaked invite link
 * reveals nothing and redeems nothing for anyone but the invited address.
 */

export const invitationRoutes = new Hono<AppEnv>()
  // The accept page's view. 404 (not 403) on email mismatch so the link leaks
  // no org metadata to the wrong account.
  .get('/:id', async (c) => {
    const { getInvitation, getUserEmail } = await import('@edgevault/database')
    const invitation = await getInvitation(c.var.database, c.req.param('id'))
    const userEmail = await getUserEmail(c.var.database, c.var.userId)
    if (!invitation || !userEmail || invitation.email !== userEmail.toLowerCase()) {
      return c.json({ error: 'not_found' }, 404)
    }
    const expired = invitation.status === 'expired' || +invitation.expiresAt < Date.now()
    return c.json({
      invitation: {
        organizationName: invitation.organizationName,
        email: invitation.email,
        role: invitation.role,
        inviterName: invitation.inviterName,
        status: expired && invitation.status === 'pending' ? 'expired' : invitation.status,
        expiresAt: invitation.expiresAt,
      },
    })
  })
  .post('/:id/accept', async (c) => {
    const { acceptInvitation, getUserEmail } = await import('@edgevault/database')
    const { isEmailVerified } = await import('../database/queries')
    if (!(await isEmailVerified(c.var.database, c.var.userId))) {
      return c.json(
        { error: 'email_unverified', detail: 'Verify your email to accept this invitation.' },
        403,
      )
    }
    const userEmail = await getUserEmail(c.var.database, c.var.userId)
    if (!userEmail) return c.json({ error: 'not_found' }, 404)
    const result = await acceptInvitation(c.var.database, {
      id: c.req.param('id'),
      userId: c.var.userId,
      userEmail,
    })
    if (!result.ok) {
      // email_mismatch reads as not_found for the same no-leak reason as GET.
      if (result.error === 'email_mismatch' || result.error === 'not_found') {
        return c.json({ error: 'not_found' }, 404)
      }
      return c.json({ error: result.error }, 410)
    }
    return c.json({
      ok: true,
      organizationId: result.organizationId,
      role: result.role,
      alreadyMember: result.alreadyMember,
    })
  })
