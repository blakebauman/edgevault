import { eq } from 'drizzle-orm'
import type { Database } from './client'
import { entitlements } from './schema/entitlements'

/** Shared entitlement queries (used by api/auth read paths + the control plane). */

export interface EntitlementRow {
  plan: string
  entitlements: string[]
}

export async function getEntitlements(
  database: Database,
  organizationId: string,
): Promise<EntitlementRow | null> {
  const [row] = await database
    .select({ plan: entitlements.plan, entitlements: entitlements.entitlements })
    .from(entitlements)
    .where(eq(entitlements.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

export async function upsertEntitlements(
  database: Database,
  input: { organizationId: string; plan: string; entitlements: string[] },
): Promise<void> {
  await database
    .insert(entitlements)
    .values({
      organizationId: input.organizationId,
      plan: input.plan,
      entitlements: input.entitlements,
    })
    .onConflictDoUpdate({
      target: entitlements.organizationId,
      set: { plan: input.plan, entitlements: input.entitlements, updatedAt: new Date() },
    })
}
