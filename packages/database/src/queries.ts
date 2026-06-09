import { and, countDistinct, eq, gte, inArray, lt } from 'drizzle-orm'
import type { Database } from './client'
import { accounts, sessions, users } from './schema/auth'
import { totpCredentials } from './schema/mfa'
import { invitations, members, organizations } from './schema/organization'
import { samlAssertionReplay, samlConnections } from './schema/saml'
import { scimConnections } from './schema/scim'
import { ssoConnections } from './schema/sso'
import { stripeCustomers, stripeMeterWatermarks } from './schema/stripe'
import { authenticators } from './schema/webauthn'
import { workspaces } from './schema/workspace'

/** Resolve an organization's id from its slug (SSO sign-in types the slug). */
export async function getOrganizationIdBySlug(
  database: Database,
  slug: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1)
  return row?.id ?? null
}

/**
 * Read an org's stored SCIM provisioning token hash (SHA-256 hex), or null if
 * SCIM isn't configured. The api worker compares this against the IdP's bearer
 * token before serving any directory data.
 */
export async function getScimTokenHash(
  database: Database,
  organizationId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ tokenHash: scimConnections.tokenHash })
    .from(scimConnections)
    .where(eq(scimConnections.organizationId, organizationId))
    .limit(1)
  return row?.tokenHash ?? null
}

/**
 * Store (or rotate, or clear) an org's SCIM provisioning token hash. Pass a hash
 * to provision/rotate (upserting the scim_connections row); pass null to revoke
 * (deleting the row). Returns true if the org now has SCIM configured, false if
 * it was cleared.
 */
export async function setScimTokenHash(
  database: Database,
  organizationId: string,
  scimTokenHash: string | null,
): Promise<boolean> {
  if (scimTokenHash === null) {
    await database.delete(scimConnections).where(eq(scimConnections.organizationId, organizationId))
    return false
  }
  await database
    .insert(scimConnections)
    .values({ organizationId, tokenHash: scimTokenHash })
    .onConflictDoUpdate({
      target: scimConnections.organizationId,
      set: { tokenHash: scimTokenHash, updatedAt: new Date() },
    })
  return true
}

/** Record (or move) the Stripe customer that pays for an org, with its plan. */
export async function upsertStripeCustomer(
  database: Database,
  input: { organizationId: string; stripeCustomerId: string; plan?: string },
): Promise<void> {
  const plan = input.plan ?? 'free'
  await database
    .insert(stripeCustomers)
    .values({
      organizationId: input.organizationId,
      stripeCustomerId: input.stripeCustomerId,
      plan,
    })
    .onConflictDoUpdate({
      target: stripeCustomers.organizationId,
      set: { stripeCustomerId: input.stripeCustomerId, plan, updatedAt: new Date() },
    })
}

/** An org's coarse billing plan tier, or 'free' if unbilled. No feature-gating. */
export async function getOrgPlan(database: Database, organizationId: string): Promise<string> {
  const [row] = await database
    .select({ plan: stripeCustomers.plan })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.organizationId, organizationId))
    .limit(1)
  return row?.plan ?? 'free'
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

/**
 * Distinct monthly-active users per organization for `[monthStart, monthEnd)`.
 * A user is active if they hold a session whose lifetime overlaps the window
 * (created before it ends, not yet expired at its start); a user counts once per
 * org they belong to. The source for the `mau` Stripe meter.
 */
export async function monthlyActiveUsersByOrg(
  database: Database,
  monthStart: Date,
  monthEnd: Date,
): Promise<Array<{ organizationId: string; users: number }>> {
  const rows = await database
    .select({
      organizationId: members.organizationId,
      users: countDistinct(sessions.userId),
    })
    .from(sessions)
    .innerJoin(members, eq(members.userId, sessions.userId))
    .where(and(lt(sessions.createdAt, monthEnd), gte(sessions.expiresAt, monthStart)))
    .groupBy(members.organizationId)
  return rows.map((r) => ({ organizationId: r.organizationId, users: Number(r.users) }))
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

/** Org membership roles, lowest to highest privilege. */
export type MemberRole = 'member' | 'admin' | 'owner'

export interface OrgMember {
  userId: string
  email: string
  name: string | null
  role: MemberRole
  joinedAt: Date
}

/** All members of an org, owners first, then by join order. */
export async function listOrgMembers(
  database: Database,
  organizationId: string,
): Promise<OrgMember[]> {
  // Transactional read: the console lists members right after a role change or
  // add, so Hyperdrive's ~60s query cache must not serve the pre-write roster
  // (same gotcha as listWorkspaces / the TOTP reads).
  const rows = await database.transaction(async (tx) =>
    tx
      .select({
        userId: members.userId,
        email: users.email,
        name: users.name,
        role: members.role,
        joinedAt: members.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(eq(members.organizationId, organizationId)),
  )
  const rank: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 }
  return rows
    .map((r) => ({ ...r, role: r.role as MemberRole }))
    .sort((a, b) => rank[a.role] - rank[b.role] || +a.joinedAt - +b.joinedAt)
}

/** Count owners — the guard rail for demote/remove (an org must keep one). */
async function countOwners(database: Database, organizationId: string): Promise<number> {
  const [row] = await database
    .select({ n: countDistinct(members.userId) })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.role, 'owner')))
  return Number(row?.n ?? 0)
}

export type MemberMutationError =
  | 'user_not_found'
  | 'already_member'
  | 'not_a_member'
  | 'last_owner'

/** Add an existing EdgeVault user (by email) to an org. The user must already
 * have an account — this is direct membership, not an email invitation. */
export async function addOrgMember(
  database: Database,
  organizationId: string,
  email: string,
  role: MemberRole,
): Promise<{ ok: true; member: OrgMember } | { ok: false; error: MemberMutationError }> {
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1)
    if (!user) return { ok: false as const, error: 'user_not_found' as const }

    const [existing] = await tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, user.id)))
      .limit(1)
    if (existing) return { ok: false as const, error: 'already_member' as const }

    const [created] = await tx
      .insert(members)
      .values({ organizationId, userId: user.id, role })
      .returning({ joinedAt: members.createdAt })
    return {
      ok: true as const,
      member: {
        userId: user.id,
        email: user.email,
        name: user.name,
        role,
        joinedAt: created?.joinedAt ?? new Date(),
      },
    }
  })
}

/** Change a member's role. Refuses to demote the org's last owner. */
export async function updateOrgMemberRole(
  database: Database,
  organizationId: string,
  userId: string,
  role: MemberRole,
): Promise<{ ok: true } | { ok: false; error: MemberMutationError }> {
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
      .limit(1)
    if (!current) return { ok: false as const, error: 'not_a_member' as const }
    if (current.role === 'owner' && role !== 'owner') {
      const owners = await countOwners(tx as unknown as Database, organizationId)
      if (owners <= 1) return { ok: false as const, error: 'last_owner' as const }
    }
    await tx
      .update(members)
      .set({ role })
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    return { ok: true as const }
  })
}

/** Remove a member. Refuses to remove the org's last owner. */
export async function removeOrgMember(
  database: Database,
  organizationId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: MemberMutationError }> {
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
      .limit(1)
    if (!current) return { ok: false as const, error: 'not_a_member' as const }
    if (current.role === 'owner') {
      const owners = await countOwners(tx as unknown as Database, organizationId)
      if (owners <= 1) return { ok: false as const, error: 'last_owner' as const }
    }
    await tx
      .delete(members)
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    return { ok: true as const }
  })
}

// --- Org invitations (email-based membership for people without an account yet) ---

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface InvitationRow {
  id: string
  organizationId: string
  organizationName: string
  email: string
  role: MemberRole
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  inviterName: string | null
  expiresAt: Date
  createdAt: Date
}

export type InvitationError =
  | 'not_found'
  | 'revoked'
  | 'already_accepted'
  | 'expired'
  | 'email_mismatch'

/**
 * Create (or refresh) an invitation. A pending invite for the same org+email is
 * refreshed in place — re-inviting and "resend" both extend the expiry rather
 * than minting a second live capability link.
 */
export async function createInvitation(
  database: Database,
  args: { organizationId: string; email: string; role: MemberRole; inviterId: string },
): Promise<{ id: string; expiresAt: Date; organizationName: string; inviterName: string | null }> {
  const email = args.email.toLowerCase()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, args.organizationId),
          eq(invitations.email, email),
          eq(invitations.status, 'pending'),
        ),
      )
      .limit(1)
    let id: string
    if (existing) {
      await tx
        .update(invitations)
        .set({ role: args.role, inviterId: args.inviterId, expiresAt })
        .where(eq(invitations.id, existing.id))
      id = existing.id
    } else {
      const [created] = await tx
        .insert(invitations)
        .values({
          organizationId: args.organizationId,
          email,
          role: args.role,
          inviterId: args.inviterId,
          expiresAt,
        })
        .returning({ id: invitations.id })
      if (!created) throw new Error('invitation insert returned no row')
      id = created.id
    }
    // Names for the email job — joined here so the api needs no second query.
    const [org] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, args.organizationId))
      .limit(1)
    const [inviter] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, args.inviterId))
      .limit(1)
    return {
      id,
      expiresAt,
      organizationName: org?.name ?? 'an organization',
      inviterName: inviter?.name ?? inviter?.email ?? null,
    }
  })
}

/** One invitation with org + inviter names (the accept page's view). */
export async function getInvitation(database: Database, id: string): Promise<InvitationRow | null> {
  const [row] = await database.transaction(async (tx) =>
    tx
      .select({
        id: invitations.id,
        organizationId: invitations.organizationId,
        organizationName: organizations.name,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        inviterName: users.name,
        inviterEmail: users.email,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(organizations, eq(invitations.organizationId, organizations.id))
      .innerJoin(users, eq(invitations.inviterId, users.id))
      .where(eq(invitations.id, id))
      .limit(1),
  )
  if (!row) return null
  const { inviterEmail, ...rest } = row
  return {
    ...rest,
    role: row.role as MemberRole,
    status: row.status as InvitationRow['status'],
    inviterName: row.inviterName ?? inviterEmail,
  }
}

/** Pending invitations for an org, newest first (expiry shown by the console). */
export async function listPendingInvitations(
  database: Database,
  organizationId: string,
): Promise<Array<Pick<InvitationRow, 'id' | 'email' | 'role' | 'expiresAt' | 'createdAt'>>> {
  // Transactional read: the console lists invitations right after sending one
  // (the Hyperdrive read-after-write cache gotcha, again).
  const rows = await database.transaction(async (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, 'pending')))
      .orderBy(invitations.createdAt),
  )
  return rows.map((r) => ({ ...r, role: r.role as MemberRole })).reverse()
}

/**
 * Accept an invitation as the signed-in user. The invitation is bound to an
 * email address — the link id alone is never enough — so a leaked URL cannot
 * be redeemed by anyone but the invited account.
 */
export async function acceptInvitation(
  database: Database,
  args: { id: string; userId: string; userEmail: string },
): Promise<
  | { ok: true; organizationId: string; role: MemberRole; alreadyMember: boolean }
  | { ok: false; error: InvitationError }
> {
  return database.transaction(async (tx) => {
    const [inv] = await tx
      .select({
        organizationId: invitations.organizationId,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(eq(invitations.id, args.id))
      .limit(1)
    if (!inv) return { ok: false as const, error: 'not_found' as const }
    if (inv.status === 'revoked') return { ok: false as const, error: 'revoked' as const }
    if (inv.status === 'accepted') return { ok: false as const, error: 'already_accepted' as const }
    if (inv.status === 'expired' || +inv.expiresAt < Date.now()) {
      return { ok: false as const, error: 'expired' as const }
    }
    if (inv.email !== args.userEmail.toLowerCase()) {
      return { ok: false as const, error: 'email_mismatch' as const }
    }

    const [existing] = await tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.organizationId, inv.organizationId), eq(members.userId, args.userId)))
      .limit(1)
    if (!existing) {
      await tx
        .insert(members)
        .values({ organizationId: inv.organizationId, userId: args.userId, role: inv.role })
    }
    await tx.update(invitations).set({ status: 'accepted' }).where(eq(invitations.id, args.id))
    return {
      ok: true as const,
      organizationId: inv.organizationId,
      role: inv.role as MemberRole,
      alreadyMember: !!existing,
    }
  })
}

/** Revoke a pending invitation (idempotent from the console's point of view). */
export async function revokeInvitation(
  database: Database,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await database
    .update(invitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.organizationId, organizationId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning({ id: invitations.id })
  return rows.length > 0
}

/** The signed-in user's email — the accept flow matches it against the invite. */
export async function getUserEmail(database: Database, userId: string): Promise<string | null> {
  const [row] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.email ?? null
}
