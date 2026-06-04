import { generateToken, hashPassword, hashToken, verifyPassword } from '@edgevault/auth'
import { type Database, sessions, users } from '@edgevault/database'
import { eq } from 'drizzle-orm'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

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
  if (!user?.passwordHash) return null
  const ok = await verifyPassword(password, user.passwordHash)
  return ok ? toPublicUser(user) : null
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
