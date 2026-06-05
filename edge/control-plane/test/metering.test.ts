import type { AuditEvent } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuditBucket,
  aggregateUsage,
  collectWindowEvents,
  METERING_SOURCE,
  type MeteringDeps,
  meterForAuditEvent,
  runMeteringCron,
} from '../src/metering'

const HOUR = 3_600_000

function auditEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    at: 0,
    workspaceId: 'ws-1',
    action: 'config.updated',
    resourceType: 'config',
    key: 'k',
    userId: 'user-1',
    ...overrides,
  }
}

/** In-memory AuditBucket over { key: ndjson } with optional forced page size. */
function fakeBucket(objects: Record<string, string>, pageSize = 1000): AuditBucket {
  return {
    async list({ prefix, cursor }) {
      const keys = Object.keys(objects)
        .filter((k) => k.startsWith(prefix))
        .sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + pageSize)
      const truncated = start + pageSize < keys.length
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(start + pageSize) } : {}),
      }
    },
    async get(key) {
      const body = objects[key]
      return body === undefined ? null : { text: async () => body }
    },
  }
}

function objectKey(writtenAtMs: number, suffix = 'a'): string {
  const day = new Date(writtenAtMs).toISOString().slice(0, 10)
  return `audit/${day}/${writtenAtMs}-${suffix}.ndjson`
}

function ndjson(events: AuditEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n')
}

describe('meterForAuditEvent', () => {
  it('maps resource types to meters', () => {
    expect(meterForAuditEvent(auditEvent({ resourceType: 'secret' }))).toBe('secret_operations')
    expect(meterForAuditEvent(auditEvent({ resourceType: 'config' }))).toBe('config_writes')
    expect(meterForAuditEvent(auditEvent({ resourceType: 'flag' }))).toBe('config_writes')
    expect(meterForAuditEvent(auditEvent({ resourceType: 'edge_read' }))).toBe('edge_reads')
    expect(meterForAuditEvent(auditEvent({ resourceType: 'mau' }))).toBe('mau')
    expect(meterForAuditEvent(auditEvent({ resourceType: 'environment' }))).toBeNull()
  })
})

describe('aggregateUsage', () => {
  it('buckets billable events per (hour, meter, workspace) inside the window', () => {
    const h0 = 1_700_000 * HOUR // hour-aligned
    const events = [
      auditEvent({ at: h0 + 1 }),
      auditEvent({ at: h0 + 2 }),
      auditEvent({ at: h0 + 3, resourceType: 'secret' }),
      auditEvent({ at: h0 + HOUR + 1 }), // next hour
      auditEvent({ at: h0 + 4, workspaceId: 'ws-2' }),
      auditEvent({ at: h0 - 1 }), // before window
      auditEvent({ at: h0 + 5, resourceType: 'environment' }), // unbilled
    ]
    const usage = aggregateUsage(events, h0, h0 + 2 * HOUR)
    expect(usage).toEqual(
      expect.arrayContaining([
        { hourStart: h0, meter: 'config_writes', workspaceId: 'ws-1', count: 2 },
        { hourStart: h0, meter: 'secret_operations', workspaceId: 'ws-1', count: 1 },
        { hourStart: h0 + HOUR, meter: 'config_writes', workspaceId: 'ws-1', count: 1 },
        { hourStart: h0, meter: 'config_writes', workspaceId: 'ws-2', count: 1 },
      ]),
    )
    expect(usage).toHaveLength(4)
  })

  it('sums the count on pre-aggregated edge_read events', () => {
    const h0 = 1_700_000 * HOUR
    const events = [
      auditEvent({ at: h0 + 1, resourceType: 'edge_read', count: 40 }),
      auditEvent({ at: h0 + 2, resourceType: 'edge_read', count: 60 }),
      auditEvent({ at: h0 + 3, resourceType: 'config' }), // count omitted → 1
    ]
    const usage = aggregateUsage(events, h0, h0 + HOUR)
    expect(usage).toEqual(
      expect.arrayContaining([
        { hourStart: h0, meter: 'edge_reads', workspaceId: 'ws-1', count: 100 },
        { hourStart: h0, meter: 'config_writes', workspaceId: 'ws-1', count: 1 },
      ]),
    )
  })
})

describe('collectWindowEvents', () => {
  it('reads in-window events, including from late-written objects', async () => {
    const from = Date.UTC(2026, 5, 3, 10)
    const to = from + HOUR
    const inWindow = auditEvent({ at: from + 5 })
    const lateBatch = auditEvent({ at: to - 1 }) // event in window…
    const afterWindow = auditEvent({ at: to + 1 })
    const bucket = fakeBucket({
      [objectKey(from + 10, 'a')]: ndjson([inWindow]),
      // …written 2 min after the window closed (queue batch lag).
      [objectKey(to + 2 * 60_000, 'b')]: ndjson([lateBatch, afterWindow]),
      [objectKey(from - HOUR, 'c')]: ndjson([auditEvent({ at: from - HOUR })]), // before
    })
    const events = await collectWindowEvents(bucket, from, to)
    expect(events.map((e) => e.at).sort()).toEqual([from + 5, to - 1])
  })

  it('spans day boundaries and survives corrupt lines + pagination', async () => {
    const from = Date.UTC(2026, 5, 3, 23) // 23:00 → window crosses midnight
    const to = from + 2 * HOUR
    const day1 = auditEvent({ at: from + 1 })
    const day2 = auditEvent({ at: from + HOUR + 1 })
    const bucket = fakeBucket(
      {
        [objectKey(from + 2, 'a')]: `${ndjson([day1])}\nnot-json`,
        [objectKey(from + HOUR + 2, 'b')]: ndjson([day2]),
        [objectKey(from + HOUR + 3, 'c')]: '',
      },
      1, // force pagination
    )
    const events = await collectWindowEvents(bucket, from, to)
    expect(events.map((e) => e.at).sort()).toEqual([from + 1, from + HOUR + 1])
  })
})

describe('runMeteringCron', () => {
  const periodEnd = Date.UTC(2026, 5, 4, 12) // metered window ends here
  const now = periodEnd + 30 * 60_000 // cron fires at 12:30 → grace keeps 12:00 closed
  const h = periodEnd - HOUR // metered hour start

  function makeDeps(overrides: Partial<MeteringDeps> = {}) {
    const reported: URLSearchParams[] = []
    const watermarks: Date[] = []
    const deps: MeteringDeps = {
      bucket: fakeBucket({
        [objectKey(h + 1, 'a')]: ndjson([
          auditEvent({ at: h + 1 }),
          auditEvent({ at: h + 2 }),
          auditEvent({ at: h + 3, resourceType: 'secret' }),
          auditEvent({ at: h + 4, workspaceId: 'ws-2' }), // same org as ws-1
          auditEvent({ at: h + 5, workspaceId: 'ws-free' }), // org without customer
        ]),
      }),
      stripeSecretKey: 'sk_test',
      getWatermark: vi.fn(async () => new Date(h)),
      setWatermark: vi.fn(async (_source, w) => {
        watermarks.push(w)
      }),
      listStripeCustomers: async () => [
        { organizationId: 'org-1', stripeCustomerId: 'cus_1' },
        { organizationId: 'org-other', stripeCustomerId: 'cus_2' },
      ],
      listWorkspaceOrganizations: async (ids) =>
        ids
          .filter((id) => id !== 'ws-missing')
          .map((id) => ({
            workspaceId: id,
            organizationId: id === 'ws-free' ? 'org-free' : 'org-1',
          })),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        reported.push(new URLSearchParams(init.body as URLSearchParams))
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      ...overrides,
    }
    return { deps, reported, watermarks }
  }

  it('meters the closed hour with idempotent identifiers and advances the watermark', async () => {
    const { deps, reported, watermarks } = makeDeps()
    const summary = await runMeteringCron(deps, now)

    expect(summary).toMatchObject({
      windowStart: h,
      windowEnd: periodEnd,
      eventsScanned: 5,
      meterEvents: 2,
      accepted: 2,
      advanced: true,
    })
    expect(deps.getWatermark).toHaveBeenCalledWith(METERING_SOURCE)
    expect(watermarks).toEqual([new Date(periodEnd)])

    const byMeter = Object.fromEntries(reported.map((p) => [p.get('event_name'), p]))
    // ws-1 + ws-2 merge into org-1/cus_1; ws-free's org has no customer → dropped.
    expect(byMeter.config_writes?.get('payload[value]')).toBe('3')
    expect(byMeter.config_writes?.get('payload[stripe_customer_id]')).toBe('cus_1')
    expect(byMeter.config_writes?.get('identifier')).toBe(`config_writes:cus_1:${h / 1000}`)
    expect(byMeter.config_writes?.get('timestamp')).toBe(String(h / 1000))
    expect(byMeter.secret_operations?.get('payload[value]')).toBe('1')
  })

  it('does not advance the watermark when Stripe rejects events', async () => {
    const { deps, watermarks } = makeDeps({
      fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    })
    const summary = await runMeteringCron(deps, now)
    expect(summary.advanced).toBe(false)
    expect(summary.accepted).toBe(0)
    expect(watermarks).toEqual([])
  })

  it('advances over an empty window without calling Stripe', async () => {
    const fetchImpl = vi.fn()
    const { deps, watermarks } = makeDeps({
      bucket: fakeBucket({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const summary = await runMeteringCron(deps, now)
    expect(summary).toMatchObject({ meterEvents: 0, advanced: true })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(watermarks).toEqual([new Date(periodEnd)])
  })

  it('is a no-op while the current hour is still open', async () => {
    const { deps, watermarks } = makeDeps({
      getWatermark: async () => new Date(periodEnd),
    })
    const summary = await runMeteringCron(deps, now)
    expect(summary.advanced).toBe(false)
    expect(summary.eventsScanned).toBe(0)
    expect(watermarks).toEqual([])
  })

  it('defaults to one hour and caps the replay window at 24h', async () => {
    const fresh = await runMeteringCron(makeDeps({ getWatermark: async () => null }).deps, now)
    expect(fresh.windowStart).toBe(periodEnd - HOUR)

    const stale = await runMeteringCron(
      makeDeps({ getWatermark: async () => new Date(periodEnd - 100 * HOUR) }).deps,
      now,
    )
    expect(stale.windowStart).toBe(periodEnd - 24 * HOUR)
  })
})
