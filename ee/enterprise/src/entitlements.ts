import type { EntitlementRow } from '@edgevault/database'
import {
  ENTITLEMENTS,
  type Entitlement,
  freeLicense,
  type License,
  type Plan,
} from '@edgevault/licensing'

const KNOWN: ReadonlySet<string> = new Set(Object.values(ENTITLEMENTS))

/**
 * Convert the Neon entitlements row (written by the Managed Edge control-plane
 * from Stripe subscription state) into a runtime {@link License}. Unknown plan
 * values fall back to `free`; unrecognized entitlement strings are dropped so a
 * malformed row can never silently grant an ee/ feature. A missing row is a
 * free-tier org.
 */
export function rowToLicense(organizationId: string, row: EntitlementRow | null): License {
  if (!row) return freeLicense(organizationId)
  const plan: Plan = isPlan(row.plan) ? row.plan : 'free'
  const entitlements = row.entitlements.filter((e): e is Entitlement => KNOWN.has(e))
  return { organizationId, plan, entitlements, expiresAt: null }
}

function isPlan(value: string): value is Plan {
  return value === 'free' || value === 'pro' || value === 'team' || value === 'enterprise'
}
