/**
 * Stripe billing logic for Managed Edge (proprietary). Webhook signature
 * verification is done with WebCrypto (no Stripe SDK needed). Subscription
 * events carry the org's coarse plan tier (free/pro/team/enterprise) in their
 * metadata, which the control plane records for billing display. There is no
 * feature-gating attached — every feature is core; the plan is purely a billing
 * label (the platform monetizes through usage metering + self-serve tiers).
 */

export type Plan = 'free' | 'pro' | 'team' | 'enterprise'

const encoder = new TextEncoder()

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Verify a Stripe-Signature header (t=..,v1=..) over the raw body. */
export async function verifyStripeWebhook(
  body: string,
  signatureHeader: string,
  secret: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('=', 2) as [string, string]),
  )
  const timestamp = Number(parts.t)
  const provided = parts.v1
  if (!Number.isFinite(timestamp) || !provided) return false

  if (opts.nowSeconds !== undefined) {
    if (Math.abs(opts.nowSeconds - timestamp) > (opts.toleranceSeconds ?? 300)) return false
  }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`)
  return timingSafeEqual(expected, provided)
}

/** Normalize an arbitrary plan string to a known tier (unknown → free). */
export function normalizePlan(plan: string): Plan {
  return plan === 'pro' || plan === 'team' || plan === 'enterprise' ? plan : 'free'
}

export interface StripePlanUpdate {
  organizationId: string
  plan: Plan
  /** true when the subscription was cancelled — revert to free. */
  revoked: boolean
  /** Stripe customer id (`customer` on the subscription) — recorded so the
   * metering cron can attribute usage. Kept on cancellation (final invoices
   * may still need meter events). */
  stripeCustomerId?: string
}

interface StripeEvent {
  type?: string
  data?: { object?: Record<string, unknown> }
}

/**
 * Translate a relevant Stripe subscription event into a plan update. Returns
 * null for events we don't act on. `organizationId` + `plan` are carried in
 * subscription metadata set at Checkout.
 */
export function planUpdateFromEvent(event: StripeEvent): StripePlanUpdate | null {
  if (!event.type?.startsWith('customer.subscription.')) return null
  const subscription = event.data?.object ?? {}
  const metadata = (subscription.metadata as Record<string, string> | undefined) ?? {}
  const organizationId = metadata.organizationId
  if (!organizationId) return null

  const revoked =
    event.type === 'customer.subscription.deleted' || subscription.status === 'canceled'
  const plan = revoked ? 'free' : normalizePlan(metadata.plan ?? 'free')
  const customer = subscription.customer
  return {
    organizationId,
    plan,
    revoked,
    ...(typeof customer === 'string' && customer !== '' ? { stripeCustomerId: customer } : {}),
  }
}
