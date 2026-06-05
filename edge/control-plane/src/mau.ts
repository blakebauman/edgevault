import { type MeterEvent, reportMeterEvents } from './metering'

/**
 * Monthly-active-users metering.
 *
 * MAU is a distinct count, not an additive stream, so it does not ride the audit
 * pipeline. Instead, once a UTC month has fully elapsed, this reports a single
 * `mau` meter event per org with that month's distinct active-user count. The
 * event identifier `mau:<customer>:<monthStartSec>` makes the report idempotent
 * (Stripe dedupes on it), and a watermark advances only when every event for the
 * month was accepted — so a partial failure simply replays next run.
 */
export const MAU_SOURCE = 'mau'

/** Start of the UTC month containing `ms`. */
export function monthStartUTC(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** Start of the UTC month `delta` months after the one starting at `monthStartMs`. */
export function addMonthsUTC(monthStartMs: number, delta: number): number {
  const d = new Date(monthStartMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)
}

export interface MauDeps {
  stripeSecretKey: string
  getWatermark(source: string): Promise<Date | null>
  setWatermark(source: string, watermark: Date): Promise<void>
  monthlyActiveUsers(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<Array<{ organizationId: string; users: number }>>
  listStripeCustomers(): Promise<Array<{ organizationId: string; stripeCustomerId: string }>>
  fetchImpl?: typeof fetch
}

export interface MauRunSummary {
  /** UTC month starts that were reported this run. */
  monthsReported: number[]
  meterEvents: number
  accepted: number
}

/**
 * Report MAU for every fully-elapsed UTC month not yet metered. On the first run
 * (no watermark) only the most-recently-elapsed month is reported — history is
 * not back-filled. Stops at the first month whose events Stripe did not fully
 * accept so the watermark never skips a month.
 */
export async function runMauMetering(deps: MauDeps, nowMs: number): Promise<MauRunSummary> {
  const summary: MauRunSummary = { monthsReported: [], meterEvents: 0, accepted: 0 }

  // Only months strictly before the current (still-open) one are billable.
  const currentMonthStart = monthStartUTC(nowMs)
  const stored = await deps.getWatermark(MAU_SOURCE)
  const startMonth = stored ? monthStartUTC(stored.getTime()) : addMonthsUTC(currentMonthStart, -1)
  if (startMonth >= currentMonthStart) return summary

  const orgCustomer = new Map(
    (await deps.listStripeCustomers()).map((c) => [c.organizationId, c.stripeCustomerId]),
  )

  for (let mStart = startMonth; mStart < currentMonthStart; mStart = addMonthsUTC(mStart, 1)) {
    const mEnd = addMonthsUTC(mStart, 1)
    const usage = await deps.monthlyActiveUsers(new Date(mStart), new Date(mEnd))
    const monthStartSec = Math.floor(mStart / 1000)
    const events: MeterEvent[] = []
    for (const u of usage) {
      const customerId = orgCustomer.get(u.organizationId)
      if (!customerId || u.users <= 0) continue
      events.push({
        meter: 'mau',
        value: u.users,
        customerId,
        identifier: `mau:${customerId}:${monthStartSec}`,
        timestamp: monthStartSec,
      })
    }
    summary.meterEvents += events.length
    const accepted = await reportMeterEvents(deps.stripeSecretKey, events, deps.fetchImpl)
    summary.accepted += accepted
    // Only advance past a month once every event for it landed.
    if (accepted < events.length) break
    await deps.setWatermark(MAU_SOURCE, new Date(mEnd))
    summary.monthsReported.push(mStart)
  }
  return summary
}
