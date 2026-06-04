import { describe, expect, it, vi } from 'vitest'
import { reportMeterEvents } from '../src/metering'
import { entitlementUpdateFromEvent, planToEntitlements, verifyStripeWebhook } from '../src/stripe'

async function signStripe(body: string, secret: string, t = 1_700_000_000): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${t},v1=${hex}`
}

describe('verifyStripeWebhook', () => {
  it('accepts a correctly signed payload', async () => {
    const body = '{"type":"customer.subscription.created"}'
    const header = await signStripe(body, 'whsec_test')
    expect(
      await verifyStripeWebhook(body, header, 'whsec_test', { nowSeconds: 1_700_000_100 }),
    ).toBe(true)
  })

  it('rejects a tampered payload or wrong secret', async () => {
    const header = await signStripe('{"a":1}', 'whsec_test')
    expect(await verifyStripeWebhook('{"a":2}', header, 'whsec_test')).toBe(false)
    expect(await verifyStripeWebhook('{"a":1}', header, 'whsec_other')).toBe(false)
  })

  it('rejects a stale timestamp', async () => {
    const header = await signStripe('{}', 'whsec_test', 1_700_000_000)
    expect(
      await verifyStripeWebhook('{}', header, 'whsec_test', { nowSeconds: 1_700_999_999 }),
    ).toBe(false)
  })
})

describe('planToEntitlements', () => {
  it('grants enterprise everything, free nothing', () => {
    expect(planToEntitlements('enterprise').entitlements).toContain('sso')
    expect(planToEntitlements('enterprise').entitlements).toContain('scim')
    expect(planToEntitlements('free').entitlements).toEqual([])
    expect(planToEntitlements('pro').plan).toBe('pro')
  })
})

describe('entitlementUpdateFromEvent', () => {
  it('maps a subscription with org metadata to a grant', () => {
    const update = entitlementUpdateFromEvent({
      type: 'customer.subscription.created',
      data: {
        object: { status: 'active', metadata: { organizationId: 'org-1', plan: 'enterprise' } },
      },
    })
    expect(update?.organizationId).toBe('org-1')
    expect(update?.grant.plan).toBe('enterprise')
    expect(update?.revoked).toBe(false)
  })

  it('revokes to free on cancellation', () => {
    const update = entitlementUpdateFromEvent({
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { organizationId: 'org-1', plan: 'enterprise' } } },
    })
    expect(update?.revoked).toBe(true)
    expect(update?.grant.plan).toBe('free')
  })

  it('ignores unrelated events and events without an org', () => {
    expect(entitlementUpdateFromEvent({ type: 'invoice.paid' })).toBeNull()
    expect(
      entitlementUpdateFromEvent({ type: 'customer.subscription.created', data: { object: {} } }),
    ).toBeNull()
  })
})

describe('reportMeterEvents', () => {
  it('posts each meter event to Stripe (injected fetch)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch
    const accepted = await reportMeterEvents(
      'sk_test',
      [
        { meter: 'edge_reads', value: 1000, customerId: 'cus_1' },
        { meter: 'mau', value: 5, customerId: 'cus_1' },
      ],
      fetchImpl,
    )
    expect(accepted).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
