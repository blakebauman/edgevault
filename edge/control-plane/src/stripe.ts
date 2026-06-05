import { ENTITLEMENTS, type Entitlement, type Plan } from '@edgevault/licensing'

/**
 * Stripe billing logic for Managed Edge (proprietary). Webhook signature
 * verification is done with WebCrypto (no Stripe SDK needed). Subscription
 * events map a plan to the entitlements the control plane writes for an org —
 * the same entitlement model the OSS core reads (cloud sets them automatically;
 * self-host uses signed license keys).
 */

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

export interface EntitlementGrant {
  plan: Plan
  entitlements: Entitlement[]
}

/** Map a subscription plan to the entitlements an org receives. */
export function planToEntitlements(plan: string): EntitlementGrant {
  switch (plan) {
    case 'enterprise':
      return {
        plan: 'enterprise',
        entitlements: [
          ENTITLEMENTS.SSO,
          ENTITLEMENTS.SCIM,
          ENTITLEMENTS.ADVANCED_RBAC,
          ENTITLEMENTS.AUDIT_RETENTION,
        ],
      }
    case 'team':
      return { plan: 'team', entitlements: [ENTITLEMENTS.AUDIT_RETENTION] }
    case 'pro':
      return { plan: 'pro', entitlements: [] }
    default:
      return { plan: 'free', entitlements: [] }
  }
}

export interface StripeEntitlementUpdate {
  organizationId: string
  grant: EntitlementGrant
  /** true when the subscription was cancelled — revoke to free. */
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
 * Translate a relevant Stripe subscription event into an entitlement update.
 * Returns null for events we don't act on. `organizationId` + `plan` are carried
 * in subscription metadata set at Checkout.
 */
export function entitlementUpdateFromEvent(event: StripeEvent): StripeEntitlementUpdate | null {
  if (!event.type?.startsWith('customer.subscription.')) return null
  const subscription = event.data?.object ?? {}
  const metadata = (subscription.metadata as Record<string, string> | undefined) ?? {}
  const organizationId = metadata.organizationId
  if (!organizationId) return null

  const revoked =
    event.type === 'customer.subscription.deleted' || subscription.status === 'canceled'
  const plan = revoked ? 'free' : (metadata.plan ?? 'free')
  const customer = subscription.customer
  return {
    organizationId,
    grant: planToEntitlements(plan),
    revoked,
    ...(typeof customer === 'string' && customer !== '' ? { stripeCustomerId: customer } : {}),
  }
}
