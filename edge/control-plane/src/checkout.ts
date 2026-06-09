/**
 * Stripe Checkout + Billing Portal for Managed Edge (proprietary). Like the
 * webhook/metering paths, this talks to Stripe's REST API directly (no SDK).
 * The console BFF is the only caller (INTERNAL_TOKEN-guarded route): it
 * authenticates the user and enforces the org-admin role, then asks this
 * worker to mint a hosted-page URL the browser is redirected to.
 *
 * The Checkout Session stamps `metadata.organizationId` + `metadata.plan` onto
 * the resulting subscription — exactly what the webhook needs to record the
 * org's plan + customer mapping. Self-serve plans are pro/team; `enterprise` is
 * deliberately sales-led (set via the control plane, not Checkout) so it is not
 * purchasable here.
 */

export const SELF_SERVE_PLANS = ['pro', 'team'] as const
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number]

export function isSelfServePlan(plan: string): plan is SelfServePlan {
  return (SELF_SERVE_PLANS as readonly string[]).includes(plan)
}

/** Stripe price id for a plan from env vars; null = plan not activated. */
export function priceIdForPlan(
  vars: { STRIPE_PRICE_PRO?: string; STRIPE_PRICE_TEAM?: string },
  plan: SelfServePlan,
): string | null {
  const id = plan === 'pro' ? vars.STRIPE_PRICE_PRO : vars.STRIPE_PRICE_TEAM
  return id ? id : null
}

export interface CheckoutInput {
  organizationId: string
  plan: SelfServePlan
  priceId: string
  successUrl: string
  cancelUrl: string
  /** Reuse the org's existing Stripe customer (plan changes keep one customer). */
  customerId?: string
  /** Prefill the hosted page's email for first-time buyers. Ignored when
   * `customerId` is set — Stripe rejects `customer` + `customer_email` together. */
  customerEmail?: string
}

/** Form body for POST /v1/checkout/sessions (exported for tests). */
export function buildCheckoutParams(input: CheckoutInput): URLSearchParams {
  const params = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    // The webhook reads these off the subscription — without them the
    // subscription is ignored and no plan is recorded.
    'subscription_data[metadata][organizationId]': input.organizationId,
    'subscription_data[metadata][plan]': input.plan,
  })
  if (input.customerId) params.set('customer', input.customerId)
  else if (input.customerEmail) params.set('customer_email', input.customerEmail)
  return params
}

async function createStripeSession(
  path: '/v1/checkout/sessions' | '/v1/billing_portal/sessions',
  stripeSecretKey: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<{ url: string } | { error: string }> {
  const res = await fetchImpl(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeSecretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!res.ok) {
    // Surface Stripe's error type/message for logs, never the raw response.
    let detail = `status ${res.status}`
    try {
      const payload = (await res.json()) as { error?: { type?: string; message?: string } }
      if (payload.error?.message) detail = `${payload.error.type}: ${payload.error.message}`
    } catch {}
    return { error: detail }
  }
  const session = (await res.json()) as { url?: string }
  return session.url ? { url: session.url } : { error: 'session has no url' }
}

/** Create a hosted Checkout Session; returns the page URL to redirect to. */
export function createCheckoutSession(
  stripeSecretKey: string,
  input: CheckoutInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string } | { error: string }> {
  return createStripeSession(
    '/v1/checkout/sessions',
    stripeSecretKey,
    buildCheckoutParams(input),
    fetchImpl,
  )
}

/** Create a Billing Portal session (manage/cancel/update payment method). */
export function createPortalSession(
  stripeSecretKey: string,
  input: { customerId: string; returnUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string } | { error: string }> {
  return createStripeSession(
    '/v1/billing_portal/sessions',
    stripeSecretKey,
    new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }),
    fetchImpl,
  )
}
