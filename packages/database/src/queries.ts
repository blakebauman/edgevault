import { and, eq } from 'drizzle-orm'
import type { Database } from './client'
import { accounts } from './schema/auth'
import { entitlements } from './schema/entitlements'
import { totpCredentials } from './schema/mfa'
import { samlConnections } from './schema/saml'
import { ssoConnections } from './schema/sso'
import { authenticators } from './schema/webauthn'

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

/** A per-org SAML 2.0 connection row (the IdP certificate is public). */
export interface SamlConnectionRow {
  organizationId: string
  idpEntityId: string
  idpSsoUrl: string
  idpCertificate: string
  spEntityId: string
  acsUrl: string
}

export async function getSamlConnection(
  database: Database,
  organizationId: string,
): Promise<SamlConnectionRow | null> {
  const [row] = await database
    .select({
      organizationId: samlConnections.organizationId,
      idpEntityId: samlConnections.idpEntityId,
      idpSsoUrl: samlConnections.idpSsoUrl,
      idpCertificate: samlConnections.idpCertificate,
      spEntityId: samlConnections.spEntityId,
      acsUrl: samlConnections.acsUrl,
    })
    .from(samlConnections)
    .where(eq(samlConnections.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

export async function upsertSamlConnection(
  database: Database,
  input: SamlConnectionRow,
): Promise<void> {
  await database
    .insert(samlConnections)
    .values(input)
    .onConflictDoUpdate({
      target: samlConnections.organizationId,
      set: {
        idpEntityId: input.idpEntityId,
        idpSsoUrl: input.idpSsoUrl,
        idpCertificate: input.idpCertificate,
        spEntityId: input.spEntityId,
        acsUrl: input.acsUrl,
        updatedAt: new Date(),
      },
    })
}

/** A user's TOTP credential (secret stays encrypted; confirmedAt null until verified). */
export interface TotpCredentialRow {
  userId: string
  encryptedSecret: string
  confirmedAt: Date | null
}

export async function getTotpCredential(
  database: Database,
  userId: string,
): Promise<TotpCredentialRow | null> {
  const [row] = await database
    .select({
      userId: totpCredentials.userId,
      encryptedSecret: totpCredentials.encryptedSecret,
      confirmedAt: totpCredentials.confirmedAt,
    })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1)
  return row ?? null
}

/** Start (or restart) enrollment: store an unconfirmed encrypted secret. */
export async function upsertTotpSecret(
  database: Database,
  userId: string,
  encryptedSecret: string,
): Promise<void> {
  await database
    .insert(totpCredentials)
    .values({ userId, encryptedSecret })
    .onConflictDoUpdate({
      target: totpCredentials.userId,
      set: { encryptedSecret, confirmedAt: null, createdAt: new Date() },
    })
}

export async function confirmTotpCredential(database: Database, userId: string): Promise<void> {
  await database
    .update(totpCredentials)
    .set({ confirmedAt: new Date() })
    .where(eq(totpCredentials.userId, userId))
}

export async function deleteTotpCredential(database: Database, userId: string): Promise<void> {
  await database.delete(totpCredentials).where(eq(totpCredentials.userId, userId))
}

/** A registered WebAuthn authenticator (publicKey is Base64URL of the COSE key). */
export interface AuthenticatorRow {
  id: string
  userId: string
  publicKey: string
  counter: number
  transports: string[]
}

export async function getAuthenticatorsByUser(
  database: Database,
  userId: string,
): Promise<AuthenticatorRow[]> {
  return database
    .select({
      id: authenticators.id,
      userId: authenticators.userId,
      publicKey: authenticators.publicKey,
      counter: authenticators.counter,
      transports: authenticators.transports,
    })
    .from(authenticators)
    .where(eq(authenticators.userId, userId))
}

export async function getAuthenticatorById(
  database: Database,
  id: string,
): Promise<AuthenticatorRow | null> {
  const [row] = await database
    .select({
      id: authenticators.id,
      userId: authenticators.userId,
      publicKey: authenticators.publicKey,
      counter: authenticators.counter,
      transports: authenticators.transports,
    })
    .from(authenticators)
    .where(eq(authenticators.id, id))
    .limit(1)
  return row ?? null
}

export async function createAuthenticator(
  database: Database,
  input: AuthenticatorRow,
): Promise<void> {
  await database.insert(authenticators).values(input)
}

export async function updateAuthenticatorCounter(
  database: Database,
  id: string,
  counter: number,
): Promise<void> {
  await database.update(authenticators).set({ counter }).where(eq(authenticators.id, id))
}

/** Look up the user linked to an external (social/OIDC) account. */
export async function getAccountByProvider(
  database: Database,
  providerId: string,
  accountId: string,
): Promise<{ userId: string } | null> {
  const [row] = await database
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, providerId), eq(accounts.accountId, accountId)))
    .limit(1)
  return row ?? null
}
