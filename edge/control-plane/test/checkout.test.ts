import { describe, expect, it, vi } from 'vitest'
import {
  buildCheckoutParams,
  createCheckoutSession,
  isSelfServePlan,
  priceIdForPlan,
} from '../src/checkout'
import worker from '../src/index'

describe('plan → price resolution', () => {
  it('only pro and team are self-serve', () => {
    expect(isSelfServePlan('pro')).toBe(true)
    expect(isSelfServePlan('team')).toBe(true)
    expect(isSelfServePlan('enterprise')).toBe(false) // sales-led
    expect(isSelfServePlan('free')).toBe(false)
  })

  it('resolves price ids from vars, null when unconfigured', () => {
    const vars = { STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: '' }
    expect(priceIdForPlan(vars, 'pro')).toBe('price_pro')
    expect(priceIdForPlan(vars, 'team')).toBeNull()
  })
})

describe('buildCheckoutParams', () => {
  const base = {
    organizationId: 'org-1',
    plan: 'pro' as const,
    priceId: 'price_pro',
    successUrl: 'https://app.example/billing?checkout=success',
    cancelUrl: 'https://app.example/billing?checkout=cancelled',
  }

  it('stamps the subscription metadata the webhook depends on', () => {
    const params = buildCheckoutParams(base)
    expect(params.get('mode')).toBe('subscription')
    expect(params.get('line_items[0][price]')).toBe('price_pro')
    expect(params.get('subscription_data[metadata][organizationId]')).toBe('org-1')
    expect(params.get('subscription_data[metadata][plan]')).toBe('pro')
    expect(params.get('client_reference_id')).toBe('org-1')
    expect(params.get('customer')).toBeNull() // new customer minted by Stripe
  })

  it('reuses an existing Stripe customer when mapped', () => {
    const params = buildCheckoutParams({ ...base, customerId: 'cus_1' })
    expect(params.get('customer')).toBe('cus_1')
  })
})

describe('createCheckoutSession', () => {
  it('returns the hosted page url', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/x' })),
    ) as unknown as typeof fetch
    const session = await createCheckoutSession(
      'sk_test',
      {
        organizationId: 'org-1',
        plan: 'pro',
        priceId: 'price_pro',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/no',
      },
      fetchImpl,
    )
    expect(session).toEqual({ url: 'https://checkout.stripe.com/c/x' })
  })

  it("surfaces Stripe's error without throwing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'No such price' } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch
    const session = await createCheckoutSession(
      'sk_test',
      {
        organizationId: 'org-1',
        plan: 'pro',
        priceId: 'price_missing',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/no',
      },
      fetchImpl,
    )
    expect(session).toEqual({ error: 'invalid_request_error: No such price' })
  })
})

describe('/billing route guards (Hono app)', () => {
  // Guards run before any DB middleware, so a partial Env is sufficient.
  const env = { INTERNAL_TOKEN: 'a'.repeat(64), STRIPE_SECRET_KEY: '' } as unknown as Env

  it('401s without (or with a wrong) internal token', async () => {
    const no = await worker.fetch?.(
      new Request('https://cp/billing/status?organizationId=org-1'),
      env,
      {} as ExecutionContext,
    )
    expect(no?.status).toBe(401)
    const wrong = await worker.fetch?.(
      new Request('https://cp/billing/status?organizationId=org-1', {
        headers: { 'x-internal-token': 'b'.repeat(64) },
      }),
      env,
      {} as ExecutionContext,
    )
    expect(wrong?.status).toBe(401)
  })

  it('503s when authenticated but billing is not activated', async () => {
    const res = await worker.fetch?.(
      new Request('https://cp/billing/status?organizationId=org-1', {
        headers: { 'x-internal-token': 'a'.repeat(64) },
      }),
      env,
      {} as ExecutionContext,
    )
    expect(res?.status).toBe(503)
  })

  it('health stays public and the webhook still fails clean unactivated', async () => {
    const health = await worker.fetch?.(
      new Request('https://cp/health'),
      env,
      {} as ExecutionContext,
    )
    expect(health?.status).toBe(200)
    const webhook = await worker.fetch?.(
      new Request('https://cp/webhooks/stripe', { method: 'POST', body: '{}' }),
      { ...env, STRIPE_WEBHOOK_SECRET: '' } as unknown as Env,
      {} as ExecutionContext,
    )
    expect(webhook?.status).toBe(503)
  })
})
