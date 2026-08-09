import { redirect } from 'react-router'

/**
 * Turn an org policy refusal into somewhere useful to go.
 *
 * The api answers 403 for two very different situations: "you are not a member
 * of this org" and "you are a member, but this org requires a second factor /
 * its own IdP". The console treated both as a sign-in problem and bounced to
 * `/login`, which for the second case is a loop — you sign in successfully and
 * get bounced again, with nothing on screen explaining why.
 *
 * A refusal is only worth anything if the person refused can act on it, so each
 * one redirects to its own remedy: enrol a second factor, or sign in through
 * the IdP. Anything else falls through to the caller's normal handling.
 */

interface RefusalBody {
  error?: string
  detail?: string
}

/**
 * Inspect a 403 and, when it is a policy refusal, throw the redirect that fixes
 * it. Returns normally when the response is something else, so callers keep
 * their existing not-a-member behaviour.
 *
 * Reads the body, so pass a response the caller has not consumed.
 */
export async function redirectOnPolicyRefusal(res: Response, orgId?: string): Promise<void> {
  if (res.status !== 403) return
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as RefusalBody | null
  if (!body?.error) return

  if (body.error === 'mfa_required_by_org') {
    // Account security is not org-scoped, so it stays reachable while the org
    // is closed to you — the escape hatch the policy depends on.
    throw redirect('/account/mfa?required=org')
  }
  if (body.error === 'sso_required_by_org' && orgId) {
    throw redirect(`/sso/${orgId}/start`)
  }
  if (body.error === 'sso_required_by_org') {
    throw redirect('/?blocked=sso')
  }
}
