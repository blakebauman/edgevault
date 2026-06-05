import { describe, expect, it, vi } from 'vitest'
import { addMonthsUTC, type MauDeps, monthStartUTC, runMauMetering } from '../src/mau'

const MAR = Date.UTC(2026, 2, 1) // 2026-03-01
const APR = Date.UTC(2026, 3, 1)
const MAY = Date.UTC(2026, 4, 1)
const midApril = Date.UTC(2026, 3, 15, 12)

function okFetch() {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
}

function deps(over: Partial<MauDeps> = {}): MauDeps & {
  watermarks: Map<string, Date>
} {
  const watermarks = new Map<string, Date>()
  return {
    watermarks,
    stripeSecretKey: 'sk_test',
    fetchImpl: okFetch(),
    getWatermark: async (s) => watermarks.get(s) ?? null,
    setWatermark: async (s, w) => void watermarks.set(s, w),
    listStripeCustomers: async () => [{ organizationId: 'org-1', stripeCustomerId: 'cus_1' }],
    monthlyActiveUsers: async () => [{ organizationId: 'org-1', users: 7 }],
    ...over,
  }
}

describe('UTC month helpers', () => {
  it('finds the month start and steps months (with year rollover)', () => {
    expect(monthStartUTC(midApril)).toBe(APR)
    expect(addMonthsUTC(APR, 1)).toBe(MAY)
    expect(addMonthsUTC(APR, -1)).toBe(MAR)
    expect(addMonthsUTC(Date.UTC(2026, 11, 1), 1)).toBe(Date.UTC(2027, 0, 1))
  })
})

describe('runMauMetering', () => {
  it('reports only the last fully-elapsed month on the first run', async () => {
    const queried: Array<[number, number]> = []
    const d = deps({
      monthlyActiveUsers: async (start, end) => {
        queried.push([start.getTime(), end.getTime()])
        return [{ organizationId: 'org-1', users: 7 }]
      },
    })
    const summary = await runMauMetering(d, midApril) // current month = April
    expect(queried).toEqual([[MAR, APR]]) // only March (last full month)
    expect(summary.monthsReported).toEqual([MAR])
    expect(summary.meterEvents).toBe(1)
    expect(summary.accepted).toBe(1)
    expect(d.watermarks.get('mau')).toEqual(new Date(APR))
  })

  it('is idempotent once a month is watermarked', async () => {
    const d = deps()
    d.watermarks.set('mau', new Date(APR)) // March already reported
    const summary = await runMauMetering(d, midApril)
    expect(summary.monthsReported).toEqual([])
    expect(summary.meterEvents).toBe(0)
  })

  it('reports each elapsed month with an idempotent per-month identifier', async () => {
    const reported: string[] = []
    const d = deps({
      fetchImpl: vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = String(init?.body)
        reported.push(new URLSearchParams(body).get('identifier') ?? '')
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    d.watermarks.set('mau', new Date(MAR)) // start from March
    await runMauMetering(d, Date.UTC(2026, 4, 10)) // current = May → report Mar + Apr
    expect(reported).toEqual([
      `mau:cus_1:${Math.floor(MAR / 1000)}`,
      `mau:cus_1:${Math.floor(APR / 1000)}`,
    ])
    expect(d.watermarks.get('mau')).toEqual(new Date(MAY))
  })

  it('skips orgs with no Stripe customer and zero-user months', async () => {
    const d = deps({
      listStripeCustomers: async () => [],
      monthlyActiveUsers: async () => [{ organizationId: 'org-x', users: 3 }],
    })
    const summary = await runMauMetering(d, midApril)
    expect(summary.meterEvents).toBe(0)
    // Nothing billable, but the month is still considered reported (watermark advances).
    expect(summary.monthsReported).toEqual([MAR])
  })

  it('does not advance the watermark past a month Stripe rejected', async () => {
    const d = deps({
      fetchImpl: vi.fn(
        async () => new Response('error', { status: 500 }),
      ) as unknown as typeof fetch,
    })
    const summary = await runMauMetering(d, midApril)
    expect(summary.accepted).toBe(0)
    expect(summary.monthsReported).toEqual([])
    expect(d.watermarks.get('mau')).toBeUndefined()
  })
})
