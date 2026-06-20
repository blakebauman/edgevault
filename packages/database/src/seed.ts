import 'dotenv/config'
import { hashPassword } from '@edgevault/auth'
import { createDatabase } from './client'
import { members, organizations, users } from './schema'

/**
 * Local dev seed: a single pre-verified user that owns one organization, so you
 * can sign in to the console immediately instead of walking the signup +
 * email-verification flow on every fresh branch.
 *
 * Run it against the Neon Local proxy:
 *   pnpm db:up && pnpm db:migrate:local && pnpm db:seed:local
 *
 * Idempotent — re-running resets the password and re-asserts verification, so
 * it doubles as a "reset my dev login" button.
 *
 * SAFETY: a pre-verified account with a known password is a credential. This
 * script refuses to run against anything but a localhost database unless you
 * explicitly set SEED_ALLOW_REMOTE=1, so it can never plant a backdoor login in
 * a shared staging/prod branch.
 *
 * Override any of these via env: SEED_EMAIL, SEED_PASSWORD, SEED_NAME,
 * SEED_ORG_NAME, SEED_ORG_SLUG.
 */

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is not set. Use `pnpm db:seed:local`, or set it explicitly.')
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const host = new URL(url).hostname
if (!LOCAL_HOSTS.has(host) && process.env.SEED_ALLOW_REMOTE !== '1') {
  throw new Error(
    `Refusing to seed a known-credential dev user into non-local host "${host}". ` +
      'This guards against planting a backdoor account in staging/prod. ' +
      'If you really mean to, re-run with SEED_ALLOW_REMOTE=1.',
  )
}

const email = process.env.SEED_EMAIL ?? 'dev@edgevault.test'
const password = process.env.SEED_PASSWORD ?? 'devpassword123!'
const name = process.env.SEED_NAME ?? 'Dev User'
const orgName = process.env.SEED_ORG_NAME ?? 'Dev Org'
const orgSlug = process.env.SEED_ORG_SLUG ?? 'dev-org'

const { database, close } = createDatabase(url)

try {
  const passwordHash = await hashPassword(password)

  // User: verified up front. onConflictDoUpdate makes re-runs a password reset.
  const [user] = await database
    .insert(users)
    .values({ email, name, passwordHash, emailVerified: true })
    .onConflictDoUpdate({
      target: users.email,
      set: { name, passwordHash, emailVerified: true, updatedAt: new Date() },
    })
    .returning()
  if (!user) throw new Error('user upsert returned no row')

  // Org with the friction off (reveal step-up / MFA / SSO-only all disabled) so
  // local secret reveals don't demand a second factor. New real orgs default to
  // step-up ON; this is a deliberate dev-only relaxation.
  const [org] = await database
    .insert(organizations)
    .values({
      name: orgName,
      slug: orgSlug,
      requireStepUpForReveal: false,
      requireMfa: false,
      ssoOnly: false,
    })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: { name: orgName, requireStepUpForReveal: false, updatedAt: new Date() },
    })
    .returning()
  if (!org) throw new Error('organization upsert returned no row')

  // Owner membership. Re-assert role on re-run in case it was demoted.
  await database
    .insert(members)
    .values({ organizationId: org.id, userId: user.id, role: 'owner' })
    .onConflictDoUpdate({
      target: [members.organizationId, members.userId],
      set: { role: 'owner' },
    })

  console.log('Seeded dev user:')
  console.log(`  email:    ${email}`)
  console.log(`  password: ${password}`)
  console.log(`  user id:  ${user.id}  (email verified)`)
  console.log(`  org:      ${orgName} (${orgSlug}) ${org.id} — you are owner`)
  console.log('\nSign in at the console, then create a workspace in-app')
  console.log('(workspaces live in the Vault Durable Object, not Postgres, so')
  console.log('they can only be created through the API/console, not seeded here).')
} finally {
  await close()
}
