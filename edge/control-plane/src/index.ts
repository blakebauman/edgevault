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
 * free plan, so a single upsert covers both grant and revoke.
 */
async function applyEntitlementUpdate(env: Env, update: StripeEntitlementUpdate): Promise<void> {
  const { createDatabase, upsertEntitlements } = await import('@edgevault/database')
  const conn = createDatabase(env.HYPERDRIVE.connectionString)
  try {
    await upsertEntitlements(conn.database, {
      organizationId: update.organizationId,
      plan: update.grant.plan,
      entitlements: update.grant.entitlements,
    })
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

  async scheduled(_event, _env, ctx): Promise<void> {
    // Usage-metering cron: aggregate billable counters off the durable audit
    // pipeline (NOT sampled Analytics Engine) with idempotent watermarks, then
    // report to Stripe Billing Meters via reportMeterEvents(). Wired at deploy.
    ctx.waitUntil(Promise.resolve())
  },
} satisfies ExportedHandler<Env>
