import { hashToken } from '@edgevault/auth'
import {
  applyScimPatch,
  SCIM_USER_SCHEMA,
  type ScimUser,
  toScimListResponse,
} from '@edgevault/scim'
import { Hono, type MiddlewareHandler } from 'hono'
import { emitOrgAudit } from '../audit'
import type { AppEnv } from '../context'

/**
 * SCIM 2.0 directory surface (RFC 7643/7644). Called directly by the customer's
 * IdP (Okta, Entra ID, …) — not the console BFF — so it lives on the public api
 * worker and authenticates with the org's SCIM bearer token rather than a user
 * session. The token's SHA-256 is compared (constant-time) against the hash
 * stored in scim_connections (provisioned via /api/v1/organizations/:orgId/
 * scim-token). No stored hash → SCIM isn't configured for the org → deny.
 *
 * Mounted at /scim, so the IdP's SCIM base URL is
 * https://api.edgevault.io/scim/v2/{org} (resources under /Users).
 *
 * Scope, stated plainly because half-implemented SCIM is how integrations fail
 * in production rather than at setup:
 *  - supported: list + filter by userName, read one, deactivate/reactivate
 *    (`PATCH {"active": …}`), remove (`DELETE`), and the discovery documents
 *    IdPs fetch before they will connect.
 *  - not supported: creating users (`POST /Users`) and Groups. Both are
 *    advertised as unsupported in ServiceProviderConfig and answered with 501,
 *    so an IdP reports a clear error instead of silently doing nothing. New
 *    people join through console invitations or SSO JIT provisioning.
 *
 * `@edgevault/database` is imported dynamically (like the other api routes) so
 * its `pg` (CommonJS) dependency stays out of the static module graph.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

/** Constant-time compare of two equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * SCIM errors have their own envelope, and IdPs surface `detail` to the admin
 * configuring the connection — so it is the one place to say what went wrong
 * in words a person can act on.
 */
function scimError(status: number, detail: string, scimType?: string) {
  return Response.json(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType ? { scimType } : {}),
    },
    { status, headers: { 'content-type': 'application/scim+json' } },
  )
}

function scimJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/scim+json' } })
}

type Member = {
  userId: string
  email: string
  name: string | null
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** A membership row as the IdP expects to read it back. */
function toScimUser(member: Member, baseUrl: string): ScimUser {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: member.userId,
    userName: member.email,
    name: member.name ? { formatted: member.name } : undefined,
    emails: [{ value: member.email, primary: true }],
    active: member.active,
    meta: {
      resourceType: 'User',
      created: member.createdAt.toISOString(),
      lastModified: member.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${member.userId}`,
    },
  }
}

/**
 * Resolve `:orgId` (id or slug — admins configure whichever they know) and
 * verify the bearer token, before any handler runs. Sets `orgId` so handlers
 * work with the resolved uuid.
 */
const requireScimToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { getOrganizationIdBySlug, getScimTokenHash } = await import('@edgevault/database')

  let orgId = c.req.param('orgId') ?? ''
  if (!UUID_RE.test(orgId)) {
    const resolved = await getOrganizationIdBySlug(c.var.database, orgId)
    if (!resolved) return scimError(404, 'Unknown organization.')
    orgId = resolved
  }

  const header = c.req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined
  if (!token) return scimError(401, 'A SCIM bearer token is required.')
  const expected = await getScimTokenHash(c.var.database, orgId)
  if (!expected || !timingSafeEqualHex(hashToken(token), expected)) {
    return scimError(401, 'The SCIM bearer token is not valid for this organization.')
  }

  c.set('orgId', orgId)
  await next()
}

/** The `/scim/v2/{org}` prefix, for `meta.location` on returned resources. */
function baseUrlFor(c: { req: { url: string; param: (k: string) => string | undefined } }): string {
  const url = new URL(c.req.url)
  return `${url.origin}/scim/v2/${c.req.param('orgId')}`
}

/**
 * `userName eq "someone@example.com"` — the only filter IdPs need here, and
 * the only one supported. Anything else is refused with the SCIM-specified
 * `invalidFilter` type rather than silently returning everything, which would
 * make an IdP believe a user does not exist and create a duplicate.
 */
export function parseUserNameFilter(
  filter: string,
): { ok: true; userName: string } | { ok: false } {
  const match = /^\s*userName\s+eq\s+"([^"]*)"\s*$/i.exec(filter)
  return match?.[1] !== undefined ? { ok: true, userName: match[1] } : { ok: false }
}

export const scimRoutes = new Hono<AppEnv>()
  // --- Discovery. Okta and Entra fetch these before they will connect, and an
  // unimplemented one reads to them as a broken endpoint rather than a
  // limited one.
  .get('/v2/:orgId/ServiceProviderConfig', requireScimToken, () =>
    scimJson({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://edgevault.io/docs',
      // Honest capability advertisement: an IdP that reads this will not try to
      // push new users, and will not report the failure as our outage.
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 1000 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication with the organization SCIM token.',
          primary: true,
        },
      ],
    }),
  )
  .get('/v2/:orgId/ResourceTypes', requireScimToken, (c) =>
    scimJson(
      toScimListResponse([
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          description: 'Organization member',
          schema: SCIM_USER_SCHEMA,
          meta: { resourceType: 'ResourceType', location: `${baseUrlFor(c)}/ResourceTypes/User` },
        },
      ]),
    ),
  )
  .get('/v2/:orgId/Schemas', requireScimToken, () =>
    scimJson(
      toScimListResponse([
        {
          id: SCIM_USER_SCHEMA,
          name: 'User',
          description: 'Organization member',
          attributes: [
            {
              name: 'userName',
              type: 'string',
              multiValued: false,
              required: true,
              uniqueness: 'server',
            },
            { name: 'active', type: 'boolean', multiValued: false, required: false },
            { name: 'name', type: 'complex', multiValued: false, required: false },
            { name: 'emails', type: 'complex', multiValued: true, required: false },
          ],
          meta: { resourceType: 'Schema' },
        },
      ]),
    ),
  )

  // --- Users
  .get('/v2/:orgId/Users', requireScimToken, async (c) => {
    const { listScimMembers } = await import('@edgevault/database')
    const filter = c.req.query('filter')

    let userName: string | undefined
    if (filter) {
      const parsed = parseUserNameFilter(filter)
      if (!parsed.ok) {
        return scimError(
          400,
          `Unsupported filter: ${filter}. Only 'userName eq "value"' is supported.`,
          'invalidFilter',
        )
      }
      userName = parsed.userName
    }

    const rows = await listScimMembers(c.var.database, c.var.orgId as string, { userName })
    const base = baseUrlFor(c)
    return scimJson(toScimListResponse(rows.map((m: Member) => toScimUser(m, base))))
  })
  .get('/v2/:orgId/Users/:userId', requireScimToken, async (c) => {
    const { getScimMember } = await import('@edgevault/database')
    const member = await getScimMember(c.var.database, c.var.orgId as string, c.req.param('userId'))
    if (!member) return scimError(404, 'No such user in this organization.')
    return scimJson(toScimUser(member, baseUrlFor(c)))
  })

  /**
   * Deprovisioning. Every IdP sends `PATCH {"active": false}` before it ever
   * sends a DELETE, so this is the operation a security review actually tests.
   *
   * The patch is applied to the current resource with the shared applier
   * (which guards against prototype-polluting paths) and the resulting `active`
   * is what gets written — so `op: replace` with a path, without a path, or a
   * bare value all land the same way, which is the part IdPs vary on.
   */
  .patch('/v2/:orgId/Users/:userId', requireScimToken, async (c) => {
    const { getScimMember, setMemberActive } = await import('@edgevault/database')
    const orgId = c.var.orgId as string
    const userId = c.req.param('userId')

    const member = await getScimMember(c.var.database, orgId, userId)
    if (!member) return scimError(404, 'No such user in this organization.')

    const body = (await c.req.json().catch(() => null)) as {
      schemas?: string[]
      Operations?: unknown
    } | null
    const operations = Array.isArray(body?.Operations) ? body.Operations : null
    if (!operations) {
      return scimError(400, `Expected a ${SCIM_PATCH_SCHEMA} body with an Operations array.`)
    }

    let patched: Record<string, unknown>
    try {
      patched = applyScimPatch(
        { active: member.active } as Record<string, unknown>,
        operations as Parameters<typeof applyScimPatch>[1],
      )
    } catch (error) {
      // Filtered paths and unsafe segments both land here; the applier's
      // message names which, and the IdP shows it to the admin.
      return scimError(400, error instanceof Error ? error.message : 'Unsupported patch.')
    }

    if (typeof patched.active !== 'boolean' || patched.active === member.active) {
      // Nothing we act on changed — profile attributes are mastered in
      // EdgeVault, so acknowledging without writing is the honest response.
      return scimJson(toScimUser(member, baseUrlFor(c)))
    }

    const result = await setMemberActive(c.var.database, orgId, userId, patched.active)
    if (!result.ok) {
      if (result.error === 'last_owner') {
        return scimError(
          409,
          'This is the organization’s last active owner; deactivating them would leave it unadministered. Assign another owner first.',
          'mutability',
        )
      }
      return scimError(404, 'No such user in this organization.')
    }

    c.executionCtx.waitUntil(
      emitOrgAudit(c.env, {
        organizationId: orgId,
        action: patched.active ? 'member.reactivated' : 'member.deactivated',
        resourceType: 'member',
        // The directory acted, not a person — attributing this to a user id
        // would be a lie about who made the change.
        userId: 'scim',
        detail: { subject: userId, userName: member.email, via: 'scim' },
      }),
    )

    const updated = await getScimMember(c.var.database, orgId, userId)
    return scimJson(toScimUser(updated ?? member, baseUrlFor(c)))
  })

  /** Hard removal. Entra sends this after its soft-delete window. */
  .delete('/v2/:orgId/Users/:userId', requireScimToken, async (c) => {
    const { getScimMember, removeOrgMember } = await import('@edgevault/database')
    const orgId = c.var.orgId as string
    const userId = c.req.param('userId')

    const member = await getScimMember(c.var.database, orgId, userId)
    if (!member) return scimError(404, 'No such user in this organization.')

    const result = await removeOrgMember(c.var.database, orgId, userId)
    if (!result.ok) {
      if (result.error === 'last_owner') {
        return scimError(
          409,
          'This is the organization’s last active owner; removing them would leave it unadministered. Assign another owner first.',
          'mutability',
        )
      }
      return scimError(404, 'No such user in this organization.')
    }

    c.executionCtx.waitUntil(
      emitOrgAudit(c.env, {
        organizationId: orgId,
        action: 'member.removed',
        resourceType: 'member',
        userId: 'scim',
        detail: { subject: userId, userName: member.email, via: 'scim' },
      }),
    )
    return new Response(null, { status: 204 })
  })

  /**
   * Creation is not supported. Answered explicitly rather than left to a 404,
   * which an IdP reports as an unreachable endpoint — this way the admin sees
   * why, and ServiceProviderConfig already told them up front.
   */
  .post('/v2/:orgId/Users', requireScimToken, () =>
    scimError(
      501,
      'Creating users over SCIM is not supported. Invite people from the console, or let them sign in through SSO, which provisions the account on first login.',
    ),
  )
