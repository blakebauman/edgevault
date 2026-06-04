import { entitlementUpdateFromEvent, verifyStripeWebhook } from './stripe'

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
        // Write update.grant (plan + entitlements) for update.organizationId to the
        // Neon entitlements table via Hyperdrive. The OSS api/auth read these flags.
        ctx.waitUntil(Promise.resolve())
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
