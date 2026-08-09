import { redirect } from 'react-router'
import { redirectOnPolicyRefusal } from './org-policy'
import { loginRedirect } from './session.server'

/**
 * Org context for the `/orgs/:orgId` shell.
 *
 * Every org page starts the same way: prove the caller is a member, learn their
 * role, and bounce them if not. That was copy-pasted across six routes with
 * small differences in what a failure did; this is the one version.
 */

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface OrgContext {
  id: string
  name: string
  slug: string
  role: OrgRole
  /** Owner or admin — the bar for every mutating org action. */
  isAdmin: boolean
}

interface OrgListEntry {
  id: string
  name: string
  slug: string
  role: OrgRole
}

/**
 * Resolve the org and the caller's role in it.
 *
 * A non-member gets `/` rather than a 403: the org list is the caller's own, so
 * "not in it" and "does not exist" are the same answer, and saying which would
 * leak that the org exists.
 */
export async function requireOrg(
  env: Env,
  token: string,
  orgId: string,
  request?: Request,
): Promise<OrgContext> {
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  await redirectOnPolicyRefusal(res, orgId)
  if (res.status === 401 || res.status === 403) {
    throw request ? loginRedirect(request) : redirect('/login')
  }
  const organizations = res.ok
    ? ((await res.json()) as { organizations: OrgListEntry[] }).organizations
    : []
  const org = organizations.find((o) => o.id === orgId)
  if (!org) throw redirect('/')
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: org.role,
    isAdmin: org.role === 'owner' || org.role === 'admin',
  }
}

/**
 * JSON from an api/auth response, or `fallback` on any non-OK or parse failure.
 *
 * A policy refusal is the one failure that must not degrade quietly: rendering
 * "not configured" to someone who is actually blocked would be a lie about the
 * org's state, so it redirects to the remedy instead.
 */
export async function jsonOr<T>(res: Response, fallback: T, orgId?: string): Promise<T> {
  await redirectOnPolicyRefusal(res, orgId)
  if (!res.ok) return fallback
  try {
    return (await res.json()) as T
  } catch {
    return fallback
  }
}
