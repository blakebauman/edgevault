import type { Database } from '@edgevault/database'
import { Hono, type MiddlewareHandler } from 'hono'
import {
  createCheckoutSession,
  createPortalSession,
  isSelfServePlan,
  priceIdForPlan,
} from './checkout'
import { runMauMetering } from './mau'
import { runMeteringCron } from './metering'
import {
  entitlementUpdateFromEvent,
  type StripeEntitlementUpdate,
  timingSafeEqual,
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
    monthlyActiveUsersByOrg,
    setMeterWatermark,
  } = await import('@edgevault/database')
  const conn = createDatabase(env.HYPERDRIVE.connectionString)
  const now = Date.now()
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
      now,
    )
    console.log('metering run', summary)

    // MAU is a distinct count, reported once per fully-elapsed UTC month.
    const mau = await runMauMetering(
      {
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        getWatermark: (source) => getMeterWatermark(conn.database, source),
        setWatermark: (source, watermark) => setMeterWatermark(conn.database, source, watermark),
        monthlyActiveUsers: (start, end) => monthlyActiveUsersByOrg(conn.database, start, end),
        listStripeCustomers: () => listStripeCustomers(conn.database),
      },
      now,
    )
    console.log('mau run', mau)
  } finally {
    await conn.close()
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

type Vars = { database: Database }

/**
 * Managed Edge control plane (proprietary, SaaS-only). Handles Stripe billing
 * webhooks (→ tenant entitlements written to Neon), the self-serve Checkout /
 * Billing Portal surface for the console BFF, and the usage-metering cron.
 * Excluded from the OSS distribution.
 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'edgevault-control-plane' }))

app.onError((err, c) => {
  console.error('control-plane error', err)
  return c.json({ error: 'internal_error' }, 500)
})

app.post('/webhooks/stripe', async (c) => {
  // Deployed-but-not-activated: without the webhook secret, signature
  // verification can never succeed — fail clean instead of a WebCrypto 500.
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.text('webhook secret not configured', 503)
  }
  const body = await c.req.text()
  const signature = c.req.header('stripe-signature') ?? ''
  const valid = await verifyStripeWebhook(body, signature, c.env.STRIPE_WEBHOOK_SECRET)
  if (!valid) return c.text('invalid signature', 400)

  let event: unknown
  try {
    event = JSON.parse(body)
  } catch {
    return c.text('invalid payload', 400)
  }
  const update = entitlementUpdateFromEvent(event as { type?: string })
  if (update) {
    c.executionCtx.waitUntil(applyEntitlementUpdate(c.env, update))
  }
  return c.json({ received: true })
})

// --- /billing/* — console-BFF-only (shared INTERNAL_TOKEN mesh secret, checked
// constant-time BEFORE any DB or Stripe work). The console performs the
// user-facing authz (verified session + org owner/admin role) first.
const requireInternalToken: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (
  c,
  next,
) => {
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqual(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

// /status works pre-activation (plan display); only Checkout/Portal need Stripe.
const requireStripeKey: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: 'billing_not_activated' }, 503)
  }
  await next()
}

const billing = new Hono<{ Bindings: Env; Variables: Vars }>()
billing.use('*', requireInternalToken)
// Before the DB middleware: an unactivated checkout/portal call should 503
// without ever opening a Neon connection.
billing.use('/checkout', requireStripeKey)
billing.use('/portal', requireStripeKey)

// Open a Neon connection per billing request (closed after the response).
billing.use('*', async (c, next) => {
  const { createDatabase } = await import('@edgevault/database')
  const conn = createDatabase(c.env.HYPERDRIVE.connectionString)
  c.set('database', conn.database)
  try {
    await next()
  } finally {
    c.executionCtx.waitUntil(conn.close())
  }
})

// Plan + customer state, and which self-serve plans are buyable now.
billing.get('/status', async (c) => {
  const organizationId = c.req.query('organizationId')
  if (!organizationId) return c.json({ error: 'organizationId required' }, 400)
  const { getEntitlements, getStripeCustomer } = await import('@edgevault/database')
  const [row, customerId] = await Promise.all([
    getEntitlements(c.var.database, organizationId),
    getStripeCustomer(c.var.database, organizationId),
  ])
  return c.json({
    plan: row?.plan ?? 'free',
    entitlements: row?.entitlements ?? [],
    hasCustomer: customerId !== null,
    plans: {
      pro: Boolean(c.env.STRIPE_PRICE_PRO),
      team: Boolean(c.env.STRIPE_PRICE_TEAM),
    },
  })
})

// Mint a hosted Stripe Checkout page for a self-serve plan upgrade.
billing.post('/checkout', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    organizationId?: string
    plan?: string
    successUrl?: string
    cancelUrl?: string
    customerEmail?: string
  } | null
  const successUrl = httpUrl(body?.successUrl)
  const cancelUrl = httpUrl(body?.cancelUrl)
  if (!body?.organizationId || !body.plan || !successUrl || !cancelUrl) {
    return c.json({ error: 'invalid request' }, 400)
  }
  if (!isSelfServePlan(body.plan)) return c.json({ error: 'plan_not_self_serve' }, 400)
  const priceId = priceIdForPlan(c.env, body.plan)
  if (!priceId) return c.json({ error: 'price_not_configured' }, 501)

  const { getStripeCustomer } = await import('@edgevault/database')
  const customerId = await getStripeCustomer(c.var.database, body.organizationId)
  const customerEmail =
    typeof body.customerEmail === 'string' && body.customerEmail.includes('@')
      ? body.customerEmail
      : undefined
  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    organizationId: body.organizationId,
    plan: body.plan,
    priceId,
    successUrl,
    cancelUrl,
    ...(customerId ? { customerId } : {}),
    ...(customerEmail ? { customerEmail } : {}),
  })
  if ('error' in session) {
    console.error('checkout session failed', session.error)
    return c.json({ error: 'stripe_error' }, 502)
  }
  return c.json(session)
})

// Mint a Billing Portal session (manage payment method, change plan, cancel).
billing.post('/portal', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    organizationId?: string
    returnUrl?: string
  } | null
  const returnUrl = httpUrl(body?.returnUrl)
  if (!body?.organizationId || !returnUrl) return c.json({ error: 'invalid request' }, 400)

  const { getStripeCustomer } = await import('@edgevault/database')
  const customerId = await getStripeCustomer(c.var.database, body.organizationId)
  if (!customerId) return c.json({ error: 'no_customer' }, 404)
  const session = await createPortalSession(c.env.STRIPE_SECRET_KEY, { customerId, returnUrl })
  if ('error' in session) {
    console.error('portal session failed', session.error)
    return c.json({ error: 'stripe_error' }, 502)
  }
  return c.json(session)
})

app.route('/billing', billing)

export default {
  fetch: app.fetch,

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
