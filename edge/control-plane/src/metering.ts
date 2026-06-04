/**
 * Usage-based metering. Billable counters MUST come from the durable audit
 * pipeline (Queues -> R2 SQL), not the sampled Analytics Engine, and must be
 * reported idempotently with per-period watermarks. This module reports
 * aggregated usage to Stripe Billing Meters; the aggregation source is wired at
 * deploy.
 */

export interface MeterEvent {
  /** Stripe meter event_name, e.g. "edge_reads" / "mau" / "secrets". */
  meter: string
  value: number
  /** Stripe customer id for the org (mapped from organizationId). */
  customerId: string
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
