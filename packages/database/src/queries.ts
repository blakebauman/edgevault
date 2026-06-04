import { eq } from 'drizzle-orm'
import type { Database } from './client'
import { entitlements } from './schema/entitlements'
import { ssoConnections } from './schema/sso'

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

/**
 * Read an org's stored SCIM provisioning token hash (SHA-256 hex), or null if
 * SCIM isn't configured. Used by the enterprise worker to authenticate the SCIM
 * surface before serving any directory data.
 */
export async function getScimTokenHash(
  database: Database,
  organizationId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ scimTokenHash: entitlements.scimTokenHash })
    .from(entitlements)
    .where(eq(entitlements.organizationId, organizationId))
    .limit(1)
  return row?.scimTokenHash ?? null
}

/**
 * Store (or rotate, or clear) an org's SCIM provisioning token hash. Pass null
 * to revoke. Updates the existing entitlements row only — an org without a row
 * has no SCIM entitlement and never reaches this path. Returns true if a row was
 * updated.
 */
export async function setScimTokenHash(
  database: Database,
  organizationId: string,
  scimTokenHash: string | null,
): Promise<boolean> {
  const updated = await database
    .update(entitlements)
    .set({ scimTokenHash, updatedAt: new Date() })
    .where(eq(entitlements.organizationId, organizationId))
    .returning({ organizationId: entitlements.organizationId })
  return updated.length > 0
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

/** A per-org OIDC SSO connection row (the client secret stays encrypted). */
export interface SsoConnectionRow {
  organizationId: string
  provider: string
  issuer: string
  clientId: string
  encryptedClientSecret: string
  redirectUri: string
  scopes: string[]
}

export async function getSsoConnection(
  database: Database,
  organizationId: string,
): Promise<SsoConnectionRow | null> {
  const [row] = await database
    .select({
      organizationId: ssoConnections.organizationId,
      provider: ssoConnections.provider,
      issuer: ssoConnections.issuer,
      clientId: ssoConnections.clientId,
      encryptedClientSecret: ssoConnections.encryptedClientSecret,
      redirectUri: ssoConnections.redirectUri,
      scopes: ssoConnections.scopes,
    })
    .from(ssoConnections)
    .where(eq(ssoConnections.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

export async function upsertSsoConnection(
  database: Database,
  input: {
    organizationId: string
    issuer: string
    clientId: string
    encryptedClientSecret: string
    redirectUri: string
    scopes: string[]
  },
): Promise<void> {
  await database
    .insert(ssoConnections)
    .values({ ...input, provider: 'oidc' })
    .onConflictDoUpdate({
      target: ssoConnections.organizationId,
      set: {
        issuer: input.issuer,
        clientId: input.clientId,
        encryptedClientSecret: input.encryptedClientSecret,
        redirectUri: input.redirectUri,
        scopes: input.scopes,
        updatedAt: new Date(),
      },
    })
}
