import type { AuditEvent } from '@edgevault/edge-protocol'

/**
 * Usage-based metering. Billable counters come from the durable audit pipeline
 * (Queues → R2 NDJSON written by apps/audit), not the sampled Analytics Engine,
 * and are reported idempotently: usage is aggregated per fully-elapsed UTC hour
 * and every Stripe meter event carries a deterministic `identifier`
 * (`meter:customer:hourStart`), so replaying a window after a partial failure
 * is deduplicated on Stripe's side. A per-source watermark (Neon) only advances
 * once Stripe has accepted every event for the window.
 *
 * Meter names must match the **Billing Meter event names** configured in the
 * Stripe Dashboard (see ACTIVATION.md §4). Edge reads and MAU are NOT in the
 * audit pipeline (far too high-volume / not audit events) — metering those
 * needs a delivery-side counter and is intentionally out of scope here.
 */

export const METERING_SOURCE = 'audit'
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Queue batches land in R2 up to max_batch_timeout + retries after the events
 * they contain; scan this far past the window for late objects, and only meter
 * hours older than this so no in-flight batch is missed. */
const GRACE_MS = 10 * 60_000
/** Upper bound on a single run's window (cron downtime backstop): Stripe's
 * identifier dedup window is ~24h, so never replay anything older. */
const MAX_WINDOW_MS = 24 * HOUR_MS

/** Map an audit event to the Stripe meter it bills, or null for unbilled events. */
export function meterForAuditEvent(event: AuditEvent): string | null {
  if (event.resourceType === 'secret') return 'secret_operations'
  if (event.resourceType === 'config' || event.resourceType === 'flag') return 'config_writes'
  return null
}

export interface UsageBucket {
  /** UTC hour start (ms epoch) the usage falls in. */
  hourStart: number
  meter: string
  workspaceId: string
  count: number
}

/** Aggregate billable audit events into per-(hour, meter, workspace) counters. */
export function aggregateUsage(events: AuditEvent[], fromMs: number, toMs: number): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>()
  for (const event of events) {
    if (event.at < fromMs || event.at >= toMs) continue
    const meter = meterForAuditEvent(event)
    if (!meter) continue
    const hourStart = Math.floor(event.at / HOUR_MS) * HOUR_MS
    const key = `${hourStart}|${meter}|${event.workspaceId}`
    const bucket = buckets.get(key)
    if (bucket) bucket.count++
    else buckets.set(key, { hourStart, meter, workspaceId: event.workspaceId, count: 1 })
  }
  return [...buckets.values()]
}

/** The slice of R2Bucket the collector needs (structural, for plain-node tests). */
export interface AuditBucket {
  list(options: {
    prefix: string
    cursor?: string
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>
  get(key: string): Promise<{ text(): Promise<string> } | null>
}

/** Epoch ms encoded in an audit object key (`audit/YYYY-MM-DD/<ms>-<uuid>.ndjson`). */
function objectKeyTimestamp(key: string): number | null {
  const ms = Number(key.split('/')[2]?.split('-')[0])
  return Number.isFinite(ms) ? ms : null
}

/**
 * Read every audit event with `at` in [fromMs, toMs) from the date-partitioned
 * NDJSON store. Objects are named by write time, which trails event time by at
 * most the queue batch window — so the key scan extends GRACE_MS past `toMs`.
 */
export async function collectWindowEvents(
  bucket: AuditBucket,
  fromMs: number,
  toMs: number,
): Promise<AuditEvent[]> {
  const keyCeiling = toMs + GRACE_MS
  const events: AuditEvent[] = []
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= keyCeiling; day += DAY_MS) {
    const prefix = `audit/${new Date(day).toISOString().slice(0, 10)}/`
    let cursor: string | undefined
    do {
      const page = await bucket.list({ prefix, cursor })
      for (const object of page.objects) {
        const writtenAt = objectKeyTimestamp(object.key)
        if (writtenAt === null || writtenAt < fromMs || writtenAt > keyCeiling) continue
        const body = await bucket.get(object.key)
        if (!body) continue
        for (const line of (await body.text()).split('\n')) {
          if (!line) continue
          try {
            const event = JSON.parse(line) as AuditEvent
            if (event.at >= fromMs && event.at < toMs) events.push(event)
          } catch {
            // A corrupt line must not poison the whole window.
          }
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  return events
}

export interface MeterEvent {
  /** Stripe meter event_name, e.g. "config_writes" / "secret_operations". */
  meter: string
  value: number
  /** Stripe customer id for the org (mapped from organizationId). */
  customerId: string
  /** Deterministic dedup key — Stripe drops repeats within its dedup window. */
  identifier?: string
  /** Event time, seconds epoch (defaults to now on Stripe's side). */
  timestamp?: number
}

/** Report meter events to Stripe (injected fetch for testing). Returns #accepted. */
export async function reportMeterEvents(
  stripeSecretKey: string,
  events: MeterEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let accepted = 0
  for (const event of events) {
    const body = new URLSearchParams({
      event_name: event.meter,
      'payload[value]': String(event.value),
      'payload[stripe_customer_id]': event.customerId,
    })
    if (event.identifier) body.set('identifier', event.identifier)
    if (event.timestamp !== undefined) body.set('timestamp', String(event.timestamp))
    const res = await fetchImpl('https://api.stripe.com/v1/billing/meter_events', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stripeSecretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    if (res.ok) accepted++
  }
  return accepted
}

/** Everything the cron touches, injected so tests run without Neon/R2/Stripe. */
export interface MeteringDeps {
  bucket: AuditBucket
  stripeSecretKey: string
  getWatermark(source: string): Promise<Date | null>
  setWatermark(source: string, watermark: Date): Promise<void>
  listStripeCustomers(): Promise<Array<{ organizationId: string; stripeCustomerId: string }>>
  listWorkspaceOrganizations(
    workspaceIds: string[],
  ): Promise<Array<{ workspaceId: string; organizationId: string }>>
  fetchImpl?: typeof fetch
}

export interface MeteringRunSummary {
  windowStart: number
  windowEnd: number
  eventsScanned: number
  meterEvents: number
  accepted: number
  /** Watermark advanced — the window is fully reported (or had nothing to bill). */
  advanced: boolean
}

/**
 * One metering cron run: meter every fully-elapsed UTC hour in
 * [watermark, floor(now − grace)). Usage from orgs without a Stripe customer
 * mapping (free tier / self-host) is dropped. The watermark only advances when
 * Stripe accepted every event, so partial failures replay idempotently.
 */
export async function runMeteringCron(
  deps: MeteringDeps,
  nowMs: number,
): Promise<MeteringRunSummary> {
  const windowEnd = Math.floor((nowMs - GRACE_MS) / HOUR_MS) * HOUR_MS
  const stored = await deps.getWatermark(METERING_SOURCE)
  const windowStart = Math.max(
    stored ? stored.getTime() : windowEnd - HOUR_MS,
    windowEnd - MAX_WINDOW_MS,
  )
  const summary: MeteringRunSummary = {
    windowStart,
    windowEnd,
    eventsScanned: 0,
    meterEvents: 0,
    accepted: 0,
    advanced: false,
  }
  if (windowStart >= windowEnd) return summary

  const events = await collectWindowEvents(deps.bucket, windowStart, windowEnd)
  summary.eventsScanned = events.length
  const usage = aggregateUsage(events, windowStart, windowEnd)

  // workspace → org → Stripe customer; re-aggregate (an org can own many workspaces).
  const workspaceIds = [...new Set(usage.map((u) => u.workspaceId))]
  const workspaceOrg = new Map(
    (await deps.listWorkspaceOrganizations(workspaceIds)).map((w) => [
      w.workspaceId,
      w.organizationId,
    ]),
  )
  const orgCustomer = new Map(
    (await deps.listStripeCustomers()).map((c) => [c.organizationId, c.stripeCustomerId]),
  )
  const billable = new Map<string, MeterEvent>()
  for (const u of usage) {
    const organizationId = workspaceOrg.get(u.workspaceId)
    const customerId = organizationId && orgCustomer.get(organizationId)
    if (!customerId) continue
    const hourStartSec = Math.floor(u.hourStart / 1000)
    const key = `${u.meter}:${customerId}:${hourStartSec}`
    const existing = billable.get(key)
    if (existing) existing.value += u.count
    else
      billable.set(key, {
        meter: u.meter,
        value: u.count,
        customerId,
        identifier: key,
        timestamp: hourStartSec,
      })
  }

  const meterEvents = [...billable.values()]
  summary.meterEvents = meterEvents.length
  summary.accepted = await reportMeterEvents(deps.stripeSecretKey, meterEvents, deps.fetchImpl)
  if (summary.accepted === meterEvents.length) {
    await deps.setWatermark(METERING_SOURCE, new Date(windowEnd))
    summary.advanced = true
  }
  return summary
}
