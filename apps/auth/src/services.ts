import { generateToken, hashPassword, hashToken, verifyPassword } from '@edgevault/auth'
import {
  accounts,
  type Database,
  getAccountByProvider,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from '@edgevault/database'
import { and, eq, gte, like, ne } from 'drizzle-orm'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * A valid Argon2id hash (same cost params as live hashes) of a password no one
 * holds. When sign-in hits an unknown email — or a user with no password set —
 * we still verify against this decoy so the response time matches the real
 * path. Without it, the absent-user branch returns instantly and the timing
 * delta leaks whether an email is registered (account enumeration).
 */
const DECOY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA==$Yupwism0luQZ6BFwnVvjDh2dSdxwPnGE7Q0hztHp6V8='

export type PublicUser = {
  id: string
  email: string
  name: string | null
  emailVerified: boolean
}

function toPublicUser(u: typeof users.$inferSelect): PublicUser {
  return { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified }
}

/** Create a user with an Argon2id password hash. Returns null if email taken. */
export async function createUser(
  database: Database,
  input: { email: string; password: string; name?: string },
): Promise<PublicUser | null> {
  // Hash before any uniqueness check so the duplicate-email path costs the same
  // as the success path (no timing oracle), and let the unique index arbitrate
  // concurrent signups instead of a racy select-then-insert.
  const passwordHash = await hashPassword(input.password)
  const [created] = await database
    .insert(users)
    .values({ email: input.email, name: input.name ?? null, passwordHash })
    .onConflictDoNothing({ target: users.email })
    .returning()
  return created ? toPublicUser(created) : null
}

/** Verify email + password. Returns the user on success, else null. */
export async function verifyCredentials(
  database: Database,
  email: string,
  password: string,
): Promise<PublicUser | null> {
  const [user] = await database.select().from(users).where(eq(users.email, email)).limit(1)
  // Always run one Argon2id verification — against the user's hash if present,
  // else a decoy — so timing doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? DECOY_PASSWORD_HASH)
  if (!user?.passwordHash || !ok) return null
  return toPublicUser(user)
}

/** How a session was established — drives the org `ssoOnly` policy at /token. */
export type AuthMethod = 'password' | 'oauth' | 'sso' | 'passkey' | 'recovery'

export async function createSession(
  database: Database,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string; authMethod?: AuthMethod },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await database.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
    authMethod: meta.authMethod ?? 'password',
  })
  return { token, expiresAt }
}

export type ValidatedSession = {
  user: PublicUser
  activeOrganizationId: string | null
  authMethod: string | null
  expiresAt: Date
}

export async function validateSessionToken(
  database: Database,
  token: string,
): Promise<ValidatedSession | null> {
  const [row] = await database
    .select()
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1)
  if (!row) return null

  if (row.sessions.expiresAt.getTime() <= Date.now()) {
    await database.delete(sessions).where(eq(sessions.id, row.sessions.id))
    return null
  }

  return {
    user: toPublicUser(row.users),
    activeOrganizationId: row.sessions.activeOrganizationId,
    authMethod: row.sessions.authMethod,
    expiresAt: row.sessions.expiresAt,
  }
}

/** Org access policies enforced where org context enters a credential (/token). */
export async function getOrgAccessPolicy(
  database: Database,
  organizationId: string,
): Promise<{ requireMfa: boolean; ssoOnly: boolean }> {
  const [row] = await database
    .select({ requireMfa: organizations.requireMfa, ssoOnly: organizations.ssoOnly })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return { requireMfa: row?.requireMfa ?? false, ssoOnly: row?.ssoOnly ?? false }
}

export async function invalidateSession(database: Database, token: string): Promise<void> {
  await database.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

export interface SessionListRow {
  id: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  expiresAt: Date
}

/** Active sessions for the device-management UI (never exposes token hashes). */
export async function listSessionsForUser(
  database: Database,
  userId: string,
): Promise<SessionListRow[]> {
  const rows = await database
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
  return rows.filter((r) => r.expiresAt.getTime() > Date.now())
}

/**
 * Revoke one session by id, strictly scoped to the owner. Returns the deleted
 * token hash for KV purging, or null if the id wasn't theirs.
 */
export async function deleteSessionById(
  database: Database,
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const [row] = await database
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ tokenHash: sessions.tokenHash })
  return row?.tokenHash ?? null
}

/**
 * Revoke every session for a user (optionally sparing the one driving the
 * request). Returns the deleted token hashes so the caller can purge the KV
 * session cache too — DB delete alone leaves up to 60s of cached validity.
 */
export async function deleteSessionsForUser(
  database: Database,
  userId: string,
  options: { exceptTokenHash?: string } = {},
): Promise<string[]> {
  const condition = options.exceptTokenHash
    ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, options.exceptTokenHash))
    : eq(sessions.userId, userId)
  const rows = await database
    .delete(sessions)
    .where(condition)
    .returning({ tokenHash: sessions.tokenHash })
  return rows.map((r) => r.tokenHash)
}

// --- One-time verification tokens (email verify, password reset) -----------
// Stored hashed in the `verifications` table; `identifier` = `${purpose}:${userId}`.

export type VerificationPurpose = 'email-verify' | 'password-reset'

/** Issue a fresh single-use token for a purpose, replacing any outstanding one. */
export async function createVerificationToken(
  database: Database,
  purpose: VerificationPurpose,
  userId: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const identifier = `${purpose}:${userId}`
  const expiresAt = new Date(Date.now() + ttlMs)
  await database.delete(verifications).where(eq(verifications.identifier, identifier))
  await database.insert(verifications).values({ identifier, value: hashToken(token), expiresAt })
  return { token, expiresAt }
}

/**
 * Consume a token: the conditional DELETE … RETURNING makes it single-use by
 * construction (concurrent submits race to one winner). Returns the userId the
 * token was issued for, or null if unknown/expired/already used.
 */
export async function consumeVerificationToken(
  database: Database,
  purpose: VerificationPurpose,
  token: string,
): Promise<string | null> {
  const [row] = await database
    .delete(verifications)
    .where(
      and(
        eq(verifications.value, hashToken(token)),
        gte(verifications.expiresAt, new Date()),
        like(verifications.identifier, `${purpose}:%`),
      ),
    )
    .returning({ identifier: verifications.identifier })
  return row ? row.identifier.slice(purpose.length + 1) : null
}

export async function markEmailVerified(database: Database, userId: string): Promise<void> {
  await database
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, userId))
}

/** Look up a user by email, including whether they have a password credential. */
export async function getUserByEmail(
  database: Database,
  email: string,
): Promise<(PublicUser & { hasPassword: boolean }) | null> {
  const [user] = await database.select().from(users).where(eq(users.email, email)).limit(1)
  return user ? { ...toPublicUser(user), hasPassword: user.passwordHash !== null } : null
}

/** Set a new password (Argon2id). Callers must revoke sessions afterwards. */
export async function setUserPassword(
  database: Database,
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password)
  await database
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
}

export async function getUserById(database: Database, userId: string): Promise<PublicUser | null> {
  const [user] = await database.select().from(users).where(eq(users.id, userId)).limit(1)
  return user ? toPublicUser(user) : null
}

/**
 * Resolve a social-login identity to a user: by linked account, else by matching
 * (verified) email, else create a new password-less user. Always ensures the
 * provider account is linked. Requires a verified email to key on.
 */
export async function provisionOauthUser(
  database: Database,
  input: { providerId: string; providerAccountId: string; email: string; name?: string | null },
): Promise<PublicUser> {
  const linked = await getAccountByProvider(database, input.providerId, input.providerAccountId)
  if (linked) {
    const user = await getUserById(database, linked.userId)
    if (user) return user
  }

  const email = input.email.toLowerCase()
  const [existing] = await database.select().from(users).where(eq(users.email, email)).limit(1)
  const user =
    existing ??
    (
      await database
        .insert(users)
        .values({ email, name: input.name ?? null, emailVerified: true })
        .returning()
    )[0]
  if (!user) throw new Error('Failed to provision OAuth user')

  // Link the provider account (idempotent on the (provider, account) unique key).
  await database
    .insert(accounts)
    .values({
      userId: user.id,
      providerId: input.providerId,
      accountId: input.providerAccountId,
    })
    .onConflictDoNothing({ target: [accounts.providerId, accounts.accountId] })

  return toPublicUser(user)
}

/**
 * JIT-provision an SSO user: find them by email or create a password-less account
 * (SSO is the only credential), then ensure org membership. Used by the internal
 * SSO endpoint after the ee/enterprise worker has verified the IdP identity.
 * Email is treated as the IdP-asserted identifier and lower-cased for matching.
 */
export async function provisionSsoUser(
  database: Database,
  input: { email: string; name?: string | null; organizationId: string },
): Promise<PublicUser> {
  const email = input.email.toLowerCase()
  const [existing] = await database.select().from(users).where(eq(users.email, email)).limit(1)

  const user =
    existing ??
    (
      await database
        .insert(users)
        .values({ email, name: input.name ?? null, emailVerified: true })
        .returning()
    )[0]
  if (!user) throw new Error('Failed to provision SSO user')

  // Ensure org membership (idempotent — unique on (org, user)).
  const [member] = await database
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, input.organizationId), eq(members.userId, user.id)))
    .limit(1)
  if (!member) {
    await database
      .insert(members)
      .values({ organizationId: input.organizationId, userId: user.id, role: 'member' })
  }

  return toPublicUser(user)
}
