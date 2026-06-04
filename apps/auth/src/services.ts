import { generateToken, hashPassword, hashToken, verifyPassword } from '@edgevault/auth'
import { type Database, members, sessions, users } from '@edgevault/database'
import { and, eq } from 'drizzle-orm'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

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
  const existing = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)
  if (existing.length > 0) return null

  const passwordHash = await hashPassword(input.password)
  const [created] = await database
    .insert(users)
    .values({ email: input.email, name: input.name ?? null, passwordHash })
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

export async function createSession(
  database: Database,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await database.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  })
  return { token, expiresAt }
}

export type ValidatedSession = {
  user: PublicUser
  activeOrganizationId: string | null
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
    expiresAt: row.sessions.expiresAt,
  }
}

export async function invalidateSession(database: Database, token: string): Promise<void> {
  await database.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

export async function getUserById(database: Database, userId: string): Promise<PublicUser | null> {
  const [user] = await database.select().from(users).where(eq(users.id, userId)).limit(1)
  return user ? toPublicUser(user) : null
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
