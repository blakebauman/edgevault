import { and, eq, inArray, lt } from 'drizzle-orm'
import type { Database } from './client'
import { accounts } from './schema/auth'
import { entitlements } from './schema/entitlements'
import { totpCredentials } from './schema/mfa'
import { samlAssertionReplay, samlConnections } from './schema/saml'
import { ssoConnections } from './schema/sso'
import { stripeCustomers, stripeMeterWatermarks } from './schema/stripe'
import { authenticators } from './schema/webauthn'
import { workspaces } from './schema/workspace'

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

/** Record (or move) the Stripe customer that pays for an org. */
export async function upsertStripeCustomer(
  database: Database,
  input: { organizationId: string; stripeCustomerId: string },
): Promise<void> {
  await database
    .insert(stripeCustomers)
    .values(input)
    .onConflictDoUpdate({
      target: stripeCustomers.organizationId,
      set: { stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() },
    })
}

export interface StripeCustomerRow {
  organizationId: string
  stripeCustomerId: string
}

/** The Stripe customer paying for an org, or null if unbilled. */
export async function getStripeCustomer(
  database: Database,
  organizationId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.organizationId, organizationId))
    .limit(1)
  return row?.stripeCustomerId ?? null
}

/** All billable org → Stripe customer mappings (the metering cron's roster). */
export async function listStripeCustomers(database: Database): Promise<StripeCustomerRow[]> {
  return database
    .select({
      organizationId: stripeCustomers.organizationId,
      stripeCustomerId: stripeCustomers.stripeCustomerId,
    })
    .from(stripeCustomers)
}

/** Resolve workspaces to their owning orgs (audit events carry workspaceId only). */
export async function listWorkspaceOrganizations(
  database: Database,
  workspaceIds: string[],
): Promise<Array<{ workspaceId: string; organizationId: string }>> {
  if (workspaceIds.length === 0) return []
  return database
    .select({ workspaceId: workspaces.id, organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(inArray(workspaces.id, workspaceIds))
}

/** The metering cron's high-water mark, or null before the first run. */
export async function getMeterWatermark(database: Database, source: string): Promise<Date | null> {
  const [row] = await database
    .select({ watermark: stripeMeterWatermarks.watermark })
    .from(stripeMeterWatermarks)
    .where(eq(stripeMeterWatermarks.source, source))
    .limit(1)
  return row?.watermark ?? null
}

/** Advance the metering high-water mark (only after Stripe accepted the window). */
export async function setMeterWatermark(
  database: Database,
  source: string,
  watermark: Date,
): Promise<void> {
  await database
    .insert(stripeMeterWatermarks)
    .values({ source, watermark })
    .onConflictDoUpdate({
      target: stripeMeterWatermarks.source,
      set: { watermark, updatedAt: new Date() },
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

/**
 * Atomically consume a SAML assertion ID for replay protection. Returns `true`
 * if this is the first time the assertion is seen (the caller may proceed), or
 * `false` if it has already been consumed (a replay — reject the login). The
 * primary-key insert is the atomic guard, so concurrent ACS posts of the same
 * assertion cannot both succeed. Expired records are pruned opportunistically.
 */
export async function consumeSamlAssertion(
  database: Database,
  input: { assertionId: string; organizationId: string; expiresAt: Date },
): Promise<boolean> {
  // Keep the table bounded: an assertion past its NotOnOrAfter is already
  // rejected by the time-window check, so its replay record is no longer needed.
  await database.delete(samlAssertionReplay).where(lt(samlAssertionReplay.expiresAt, new Date()))
  const inserted = await database
    .insert(samlAssertionReplay)
    .values({
      assertionId: input.assertionId,
      organizationId: input.organizationId,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: samlAssertionReplay.assertionId })
    .returning({ assertionId: samlAssertionReplay.assertionId })
  return inserted.length > 0
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
  // Inside a transaction so Hyperdrive never serves this from its query cache:
  // enrollment/confirm/disable read this row moments after writing it, and the
  // page loader runs the identical SELECT *before* the write — a cached empty
  // result (~60s TTL) made confirm reject freshly-enrolled secrets. MFA state
  // transitions must always read current data.
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        userId: totpCredentials.userId,
        encryptedSecret: totpCredentials.encryptedSecret,
        confirmedAt: totpCredentials.confirmedAt,
      })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId))
      .limit(1)
    return row ?? null
  })
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
