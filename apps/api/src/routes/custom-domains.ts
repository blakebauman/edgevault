import { customDomains } from '@edgevault/database/schema'
import { customDomainCacheKey } from '@edgevault/edge-protocol'
import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import {
  type CfCustomHostname,
  createCustomHostname,
  deleteCustomHostname,
  extractDcvRecords,
  getCustomHostname,
  mapCfToDomainStatus,
  saasConfig,
  validateCustomHostname,
} from '../custom-hostnames'
import { getMemberRole } from '../database/queries'

/**
 * Custom delivery domains (ROADMAP 2.12): org-owned hostnames in front of the
 * delivery plane via Cloudflare for SaaS. Every route 404s unless the
 * deployment configures CF_ZONE_ID + CF_SAAS_API_TOKEN — config-driven, not
 * an entitlement check (managed plan tiers meter quantity in edge/).
 */

/** Hard per-org cap; the managed platform meters plan-tier quantity below it. */
const MAX_DOMAINS_PER_ORG = 5

const addDomain = z.object({ hostname: z.string().min(3).max(253) })

type DomainRow = typeof customDomains.$inferSelect

function serialize(row: DomainRow) {
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    failureReason: row.failureReason,
    dcvRecords: row.dcvRecords,
    createdAt: row.createdAt,
  }
}

/** The registrable suffix customers may not bring (delivery.edgevault.io → edgevault.io). */
function platformDomain(env: Env): string {
  return env.DELIVERY_HOST.split('.').slice(-2).join('.')
}

export const customDomainRoutes = new Hono<AppEnv>()
  .get('/:orgId/domains', async (c) => {
    const config = saasConfig(c.env)
    if (!config) return c.json({ error: 'not_found' }, 404)
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (!role) return c.json({ error: 'forbidden' }, 403)

    const rows = await c.var.database
      .select()
      .from(customDomains)
      .where(eq(customDomains.organizationId, orgId))

    // CF has no status webhook, so reads refresh pending rows lazily. The
    // verification workflow does the same on a 2-minute cadence; this makes
    // "Check status" in the console immediate and survives workflow timeouts.
    const refreshed = await Promise.all(
      rows.map(async (row) => {
        if (row.status !== 'pending_dcv' && row.status !== 'pending_ssl') return row
        const cf = await getCustomHostname(config, row.cfCustomHostnameId)
        if (!cf.ok) return row
        const status = mapCfToDomainStatus(cf.result.status, cf.result.ssl?.status)
        if (status === row.status) return row
        const patch = {
          status,
          updatedAt: new Date(),
          dcvRecords: extractDcvRecords(cf.result),
          failureReason: status === 'failed' ? cf.result.status : null,
        }
        await c.var.database.update(customDomains).set(patch).where(eq(customDomains.id, row.id))
        if (status === 'active') {
          await c.env.ENVIRONMENT_API_KEYS.put(customDomainCacheKey(row.hostname), orgId)
        }
        return { ...row, ...patch }
      }),
    )

    return c.json({ domains: refreshed.map(serialize), cnameTarget: c.env.DELIVERY_HOST })
  })
  .post('/:orgId/domains', zValidator('json', addDomain), async (c) => {
    const config = saasConfig(c.env)
    if (!config) return c.json({ error: 'not_found' }, 404)
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const hostname = c.req.valid('json').hostname.trim().toLowerCase()
    const invalid = validateCustomHostname(hostname, platformDomain(c.env))
    if (invalid) return c.json({ error: 'invalid_hostname', detail: invalid }, 400)

    const existing = await c.var.database
      .select({ id: customDomains.id, organizationId: customDomains.organizationId })
      .from(customDomains)
      .where(eq(customDomains.hostname, hostname))
    if (existing.length > 0) {
      const mine = existing[0]?.organizationId === orgId
      return c.json(
        {
          error: 'domain_exists',
          detail: mine
            ? 'This domain is already configured for your organization.'
            : 'This domain is already in use.',
        },
        409,
      )
    }

    const count = await c.var.database
      .select({ id: customDomains.id })
      .from(customDomains)
      .where(eq(customDomains.organizationId, orgId))
    if (count.length >= MAX_DOMAINS_PER_ORG) {
      return c.json({ error: 'domain_limit', detail: 'Custom domain limit reached.' }, 409)
    }

    const cf = await createCustomHostname(config, hostname, c.env.DELIVERY_HOST)
    if (!cf.ok) {
      return c.json({ error: 'provisioning_failed', detail: cf.errors.join('; ') }, 502)
    }

    const [row] = await c.var.database
      .insert(customDomains)
      .values({
        organizationId: orgId,
        hostname,
        cfCustomHostnameId: cf.result.id,
        status: mapCfToDomainStatus(cf.result.status, cf.result.ssl?.status),
        dcvRecords: extractDcvRecords(cf.result as CfCustomHostname),
        createdByUserId: c.var.userId,
      })
      .returning()
    if (!row) return c.json({ error: 'provisioning_failed', detail: 'Could not save domain.' }, 502)

    // Durable DCV polling (2-min cadence, ~2h cap). Best-effort: the lazy
    // refresh in GET covers a workflow that failed to start.
    await c.env.DOMAIN_VERIFICATION_WORKFLOW.create({
      params: {
        domainId: row.id,
        organizationId: orgId,
        hostname,
        cfHostnameId: cf.result.id,
      },
    }).catch(() => {})

    return c.json({ domain: serialize(row), cnameTarget: c.env.DELIVERY_HOST }, 201)
  })
  .delete('/:orgId/domains/:domainId', async (c) => {
    const config = saasConfig(c.env)
    if (!config) return c.json({ error: 'not_found' }, 404)
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const [row] = await c.var.database
      .select()
      .from(customDomains)
      .where(eq(customDomains.id, c.req.param('domainId')))
    if (!row || row.organizationId !== orgId) return c.json({ error: 'not_found' }, 404)

    // CF side first (best-effort — a half-failed delete is caught by re-delete),
    // then the row, then the delivery pin.
    await deleteCustomHostname(config, row.cfCustomHostnameId).catch(() => {})
    await c.var.database.delete(customDomains).where(eq(customDomains.id, row.id))
    await c.env.ENVIRONMENT_API_KEYS.delete(customDomainCacheKey(row.hostname))

    return c.json({ ok: true })
  })
