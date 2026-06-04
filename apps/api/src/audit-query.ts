import type { AuditEvent } from '@edgevault/edge-protocol'

/**
 * Query the cold audit warehouse (date-partitioned NDJSON in R2 written by
 * apps/audit). This is a bounded scan over the day partitions in range — fine
 * for moderate volumes and the self-host default. At scale, point this at the
 * R2 Data Catalog (Iceberg) + R2 SQL instead; the object layout is unchanged.
 */

const MAX_DAYS = 31

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * Inclusive list of YYYY-MM-DD days from `from` to `to`. If the span exceeds
 * MAX_DAYS, the window is clamped to the most recent MAX_DAYS (ending at `to`),
 * so capping never silently drops the newest events.
 */
export function daysInRange(from: string, to: string): string[] {
  const days: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  let start = Date.parse(`${from}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return days
  const earliest = end - (MAX_DAYS - 1) * 86_400_000
  if (start < earliest) start = earliest
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  return days
}

export interface AuditQuery {
  workspaceId: string
  from?: string
  to?: string
  /** Restrict to a single environment. */
  environmentId?: string
  limit?: number
  /** Clock injection for tests; defaults to now. */
  now?: number
}

/**
 * Return the workspace's audit events (newest first), scanning the R2 day
 * partitions in range. Defaults to the last 7 days, 100 events.
 */
export async function queryAuditHistory(
  bucket: R2Bucket,
  query: AuditQuery,
): Promise<AuditEvent[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const now = query.now ?? Date.now()
  const to = query.to && isYmd(query.to) ? query.to : new Date(now).toISOString().slice(0, 10)
  const from =
    query.from && isYmd(query.from)
      ? query.from
      : new Date(now - 6 * 86_400_000).toISOString().slice(0, 10)

  const events: AuditEvent[] = []
  for (const day of daysInRange(from, to)) {
    let cursor: string | undefined
    do {
      const listed = await bucket.list({ prefix: `audit/${day}/`, cursor })
      for (const object of listed.objects) {
        const body = await bucket.get(object.key)
        if (!body) continue
        const text = await body.text()
        for (const line of text.split('\n')) {
          if (!line) continue
          let event: AuditEvent
          try {
            event = JSON.parse(line) as AuditEvent
          } catch {
            continue // skip a corrupt line rather than fail the whole query
          }
          if (event.workspaceId !== query.workspaceId) continue
          if (query.environmentId && event.environmentId !== query.environmentId) continue
          events.push(event)
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  }

  events.sort((a, b) => b.at - a.at)
  return events.slice(0, limit)
}
