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
  /**
   * The scope. Exactly one of these: workspace events (config, secrets,
   * promotions) or org events (membership, policy, identity). They are separate
   * scopes rather than a hierarchy because an org view that also swept every
   * workspace would turn one bounded scan into N of them, and the two answer
   * different questions anyway.
   */
  workspaceId?: string
  organizationId?: string
  from?: string
  to?: string
  /** Restrict to a single environment (workspace scope only). */
  environmentId?: string
  /**
   * Narrowing filters. The scan already parses every line in range, so these
   * cost nothing beyond the predicate — they exist so a reviewer can answer
   * "who revealed secrets last quarter" without paging through everything.
   *
   * `action` matches a prefix so `secret` catches `secret.revealed` and `alert`
   * catches the whole anomaly family; `resourceType` and `userId` are exact.
   */
  action?: string
  resourceType?: string
  userId?: string
  limit?: number
  /** Clock injection for tests; defaults to now. */
  now?: number
}

/**
 * Scope: which events belong to this query's window at all. Kept separate from
 * the narrowing filters below so facets can be built from everything in scope —
 * otherwise picking one action would erase every other option from the filter.
 */
function inScope(event: AuditEvent, query: AuditQuery): boolean {
  if (query.organizationId) {
    // Org scope never picks up workspace events, so a membership change and a
    // config write can't be conflated in one list.
    if (event.organizationId !== query.organizationId) return false
  } else {
    if (event.workspaceId !== query.workspaceId) return false
    if (query.environmentId && event.environmentId !== query.environmentId) return false
  }
  return true
}

/** The user-selected narrowing filters, applied on top of scope. */
function matchesFilters(event: AuditEvent, query: AuditQuery): boolean {
  if (query.resourceType && event.resourceType !== query.resourceType) return false
  if (query.userId && event.userId !== query.userId) return false
  if (query.action && event.action !== query.action && !event.action.startsWith(`${query.action}.`))
    return false
  return true
}

/** Distinct values available to filter on, for the window currently in scope. */
export interface AuditFacets {
  actions: string[]
  resourceTypes: string[]
  userIds: string[]
}

/**
 * Return the workspace's audit events (newest first), scanning the R2 day
 * partitions in range. Defaults to the last 7 days, 100 events.
 *
 * `total` counts everything matching the filters before the limit slice, which
 * is what the console's "Showing N of M" line reports. `facets` is built from
 * the wider in-scope set so the filter controls stay populated after a pick.
 */
export async function queryAuditHistory(
  bucket: R2Bucket,
  query: AuditQuery,
): Promise<{ events: AuditEvent[]; total: number; facets: AuditFacets }> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const now = query.now ?? Date.now()
  const to = query.to && isYmd(query.to) ? query.to : new Date(now).toISOString().slice(0, 10)
  const from =
    query.from && isYmd(query.from)
      ? query.from
      : new Date(now - 6 * 86_400_000).toISOString().slice(0, 10)

  const events: AuditEvent[] = []
  const actions = new Set<string>()
  const resourceTypes = new Set<string>()
  const userIds = new Set<string>()

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
          if (!inScope(event, query)) continue
          actions.add(event.action)
          resourceTypes.add(event.resourceType)
          if (event.userId) userIds.add(event.userId)
          if (!matchesFilters(event, query)) continue
          events.push(event)
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  }

  events.sort((a, b) => b.at - a.at)
  return {
    events: events.slice(0, limit),
    total: events.length,
    facets: {
      actions: [...actions].sort(),
      resourceTypes: [...resourceTypes].sort(),
      userIds: [...userIds].sort(),
    },
  }
}

/**
 * Serialise events to NDJSON with a SHA-256 of exactly the bytes returned.
 *
 * Split out from the export route so the digest can be tested against real
 * content: the whole point of the header is that a reviewer can re-hash the
 * downloaded file and get the same value, and that guarantee is worth a test
 * rather than a comment.
 */
export async function buildAuditExport(
  events: AuditEvent[],
): Promise<{ ndjson: string; sha256: string }> {
  const ndjson = events.map((e) => JSON.stringify(e)).join('\n')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ndjson))
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { ndjson, sha256 }
}
