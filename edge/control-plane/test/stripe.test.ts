import { describe, expect, it, vi } from 'vitest'
import { reportMeterEvents } from '../src/metering'
import { normalizePlan, planUpdateFromEvent, verifyStripeWebhook } from '../src/stripe'

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

describe('normalizePlan', () => {
  it('passes known tiers through and collapses the rest to free', () => {
    expect(normalizePlan('enterprise')).toBe('enterprise')
    expect(normalizePlan('team')).toBe('team')
    expect(normalizePlan('pro')).toBe('pro')
    expect(normalizePlan('free')).toBe('free')
    expect(normalizePlan('bogus')).toBe('free')
  })
})

describe('planUpdateFromEvent', () => {
  it('maps a subscription with org metadata to a plan', () => {
    const update = planUpdateFromEvent({
      type: 'customer.subscription.created',
      data: {
        object: { status: 'active', metadata: { organizationId: 'org-1', plan: 'enterprise' } },
      },
    })
    expect(update?.organizationId).toBe('org-1')
    expect(update?.plan).toBe('enterprise')
    expect(update?.revoked).toBe(false)
  })

  it('revokes to free on cancellation', () => {
    const update = planUpdateFromEvent({
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { organizationId: 'org-1', plan: 'enterprise' } } },
    })
    expect(update?.revoked).toBe(true)
    expect(update?.plan).toBe('free')
  })

  it('captures the Stripe customer id for the metering roster', () => {
    const update = planUpdateFromEvent({
      type: 'customer.subscription.created',
      data: {
        object: {
          status: 'active',
          customer: 'cus_42',
          metadata: { organizationId: 'org-1', plan: 'team' },
        },
      },
    })
    expect(update?.stripeCustomerId).toBe('cus_42')
    // Cancellation keeps the mapping (final invoices may still meter usage).
    const cancelled = planUpdateFromEvent({
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_42', metadata: { organizationId: 'org-1' } } },
    })
    expect(cancelled?.stripeCustomerId).toBe('cus_42')
    // Expanded (object-valued) customer fields are not silently misused.
    const expanded = planUpdateFromEvent({
      type: 'customer.subscription.created',
      data: { object: { customer: { id: 'cus_42' }, metadata: { organizationId: 'org-1' } } },
    })
    expect(expanded?.stripeCustomerId).toBeUndefined()
  })

  it('ignores unrelated events and events without an org', () => {
    expect(planUpdateFromEvent({ type: 'invoice.paid' })).toBeNull()
    expect(
      planUpdateFromEvent({ type: 'customer.subscription.created', data: { object: {} } }),
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
