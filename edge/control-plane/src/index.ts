import { runMeteringCron } from './metering'
import {
  entitlementUpdateFromEvent,
  type StripeEntitlementUpdate,
  verifyStripeWebhook,
} from './stripe'

/**
 * Persist an entitlement change to the shared Neon table (via Hyperdrive) that
 * the OSS api/auth workers read. `@edgevault/database` is imported dynamically so
 * its `pg` (CommonJS) dependency stays out of the static module graph. On
 * cancellation `entitlementUpdateFromEvent` already collapses the grant to the
 * free plan, so a single upsert covers both grant and revoke. The org → Stripe
 * customer mapping is recorded alongside so the metering cron can attribute
 * usage.
 */
async function applyEntitlementUpdate(env: Env, update: StripeEntitlementUpdate): Promise<void> {
  const { createDatabase, upsertEntitlements, upsertStripeCustomer } = await import(
    '@edgevault/database'
  )
  const conn = createDatabase(env.HYPERDRIVE.connectionString)
  try {
    await upsertEntitlements(conn.database, {
      organizationId: update.organizationId,
      plan: update.grant.plan,
      entitlements: update.grant.entitlements,
    })
    if (update.stripeCustomerId) {
      await upsertStripeCustomer(conn.database, {
        organizationId: update.organizationId,
        stripeCustomerId: update.stripeCustomerId,
      })
    }
  } finally {
    await conn.close()
  }
}

/**
 * Meter the previous window's billable usage (audit R2 → Stripe Billing
 * Meters), with the Neon-backed watermark + customer roster injected as deps.
 */
async function runScheduledMetering(env: Env): Promise<void> {
  const {
    createDatabase,
    getMeterWatermark,
    listStripeCustomers,
    listWorkspaceOrganizations,
    setMeterWatermark,
  } = await import('@edgevault/database')
  const conn = createDatabase(env.HYPERDRIVE.connectionString)
  try {
    const summary = await runMeteringCron(
      {
        bucket: env.AUDIT_BUCKET,
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        getWatermark: (source) => getMeterWatermark(conn.database, source),
        setWatermark: (source, watermark) => setMeterWatermark(conn.database, source, watermark),
        listStripeCustomers: () => listStripeCustomers(conn.database),
        listWorkspaceOrganizations: (ids) => listWorkspaceOrganizations(conn.database, ids),
      },
      Date.now(),
    )
    console.log('metering run', summary)
  } finally {
    await conn.close()
  }
}

/**
 * Managed Edge control plane (proprietary, SaaS-only). Handles Stripe billing
 * webhooks (→ tenant entitlements written to Neon) and the usage-metering cron.
 * Excluded from the OSS distribution.
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'edgevault-control-plane' })
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/stripe') {
      // Deployed-but-not-activated: without the webhook secret, signature
      // verification can never succeed — fail clean instead of a WebCrypto 500.
      if (!env.STRIPE_WEBHOOK_SECRET) {
        return new Response('webhook secret not configured', { status: 503 })
      }
      const body = await request.text()
      const signature = request.headers.get('stripe-signature') ?? ''
      const valid = await verifyStripeWebhook(body, signature, env.STRIPE_WEBHOOK_SECRET)
      if (!valid) return new Response('invalid signature', { status: 400 })

      let event: unknown
      try {
        event = JSON.parse(body)
      } catch {
        return new Response('invalid payload', { status: 400 })
      }
      const update = entitlementUpdateFromEvent(event as { type?: string })
      if (update) {
        ctx.waitUntil(applyEntitlementUpdate(env, update))
      }
      return Response.json({ received: true })
    }

    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event, env, ctx): Promise<void> {
    // Deployed-but-not-activated: nothing can be reported without a Stripe key,
    // and skipping leaves the watermark untouched for when activation lands.
    if (!env.STRIPE_SECRET_KEY) {
      console.log('metering skipped: STRIPE_SECRET_KEY not set')
      return
    }
    ctx.waitUntil(runScheduledMetering(env))
  },
} satisfies ExportedHandler<Env>
