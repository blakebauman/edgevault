import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateTotpSecret, hashPassword, hashToken } from '@edgevault/auth'
import { encryptSecret } from '@edgevault/crypto'
import { eq } from 'drizzle-orm'
import { createDatabase } from './client'
import {
  accounts,
  authenticators,
  customDomains,
  invitations,
  members,
  organizations,
  recoveryCodes,
  samlConnections,
  scimConnections,
  ssoConnections,
  stripeCustomers,
  stripeMeterWatermarks,
  totpCredentials,
  users,
  workspaces,
} from './schema'
import { SEED_EMAIL, SEED_ORGS, SEED_PASSWORD, SEED_USERS } from './seed-fixtures'

/**
 * Local dev seed — PHASE 1 (Postgres graph).
 *
 * Plants the full relational/identity graph for three personas (a solo free
 * org, a Pro team, and an Enterprise org with SSO/SAML/SCIM) so the console is
 * populated the moment you sign in. `dev@edgevault.test` is an owner of all
 * three, so one login can switch between them.
 *
 * The config/flag/secret CONTENT lives in the Vault Durable Object, not
 * Postgres, and is seeded separately by PHASE 2 — the `/internal/seed` dev
 * endpoint in `apps/api`. Run the whole thing with:
 *
 *   pnpm db:up && pnpm db:migrate:local   # bring up + migrate Neon Local
 *   pnpm db:seed:local                    # phase 1 (this file)
 *   pnpm dev                              # (separate terminal) api worker
 *   pnpm seed:dev                         # phase 2 (DO + KV)
 *
 * Or `pnpm seed:local` to run phases 1 and 2 back to back.
 *
 * Idempotent — every write upserts on its natural key, so re-running resets the
 * dev login password and re-asserts the whole graph (doubles as a reset button).
 *
 * SAFETY: pre-verified accounts with known passwords are credentials. This
 * refuses to run against anything but a localhost database unless you set
 * SEED_ALLOW_REMOTE=1, so it can never plant a backdoor login in staging/prod.
 *
 * Overridable via env: SEED_EMAIL, SEED_PASSWORD (apply to the primary
 * dev@edgevault.test login), MASTER_KEK (enables encrypted MFA/SSO rows).
 */

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is not set. Use `pnpm db:seed:local`, or set it explicitly.')
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const host = new URL(url).hostname
if (!LOCAL_HOSTS.has(host) && process.env.SEED_ALLOW_REMOTE !== '1') {
  throw new Error(
    `Refusing to seed known-credential dev accounts into non-local host "${host}". ` +
      'This guards against planting backdoor accounts in staging/prod. ' +
      'If you really mean to, re-run with SEED_ALLOW_REMOTE=1.',
  )
}

// MASTER_KEK is needed to envelope-encrypt the TOTP secret and OIDC client
// secret. It must match the api/auth workers so the auth worker can decrypt, so
// we read it straight from apps/api/.dev.vars (env var wins if set). It's
// optional: without it we still seed everything else and just skip those two
// encrypted rows (the console still shows "MFA on" from row presence).
const masterKek = process.env.MASTER_KEK ?? readDevVarMasterKek()
if (!masterKek) {
  console.warn(
    'MASTER_KEK not set — skipping encrypted TOTP/SSO rows. ' +
      'Pass it (matching apps/auth/.dev.vars) to seed working MFA + SSO.',
  )
}

const primaryEmail = process.env.SEED_EMAIL ?? SEED_EMAIL
const primaryPassword = process.env.SEED_PASSWORD ?? SEED_PASSWORD

/** Pull MASTER_KEK from apps/api/.dev.vars so it matches the running workers. */
function readDevVarMasterKek(): string | undefined {
  try {
    const path = fileURLToPath(new URL('../../../apps/api/.dev.vars', import.meta.url))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*MASTER_KEK\s*=\s*(.*)\s*$/)
      if (m?.[1]) return m[1].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // .dev.vars not present — fall through and skip encrypted rows.
  }
  return undefined
}

const { database, close } = createDatabase(url)

try {
  const passwordHash = await hashPassword(primaryPassword)

  // --- Users + linked accounts ---------------------------------------------
  for (const u of SEED_USERS) {
    const email = u.email === SEED_EMAIL ? primaryEmail : u.email
    await database
      .insert(users)
      .values({
        id: u.id,
        email,
        name: u.name,
        image: u.image ?? null,
        emailVerified: true,
        passwordHash: u.noPassword ? null : passwordHash,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email,
          name: u.name,
          emailVerified: true,
          passwordHash: u.noPassword ? null : passwordHash,
          updatedAt: new Date(),
        },
      })

    if (u.github) {
      await database
        .insert(accounts)
        .values({
          userId: u.id,
          providerId: 'github',
          accountId: u.github.accountId,
          scope: 'read:user user:email',
        })
        .onConflictDoNothing({ target: [accounts.providerId, accounts.accountId] })
    }

    // MFA: confirmed TOTP + recovery codes + a passkey.
    if (u.mfa && masterKek) {
      const envelope = await encryptSecret(masterKek, u.id, generateTotpSecret())
      await database
        .insert(totpCredentials)
        .values({
          userId: u.id,
          encryptedSecret: JSON.stringify(envelope),
          confirmedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: totpCredentials.userId,
          set: { encryptedSecret: JSON.stringify(envelope), confirmedAt: new Date() },
        })

      await database.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id))
      await database.insert(recoveryCodes).values(
        Array.from({ length: 8 }, (_, i) => ({
          userId: u.id,
          codeHash: hashToken(`recovery-${u.id}-${i}`),
        })),
      )

      await database
        .insert(authenticators)
        .values({
          id: `seed-passkey-${u.id}`,
          userId: u.id,
          // Placeholder COSE key — enough to populate the passkey list; this
          // seeded credential isn't used for an actual WebAuthn assertion.
          publicKey: 'pQECAyYgASFYIExamplePasskeyPublicKeyXdevAAAA',
          counter: 0,
          transports: ['internal', 'hybrid'],
        })
        .onConflictDoNothing({ target: authenticators.id })
    }
  }

  // --- Organizations + the rest of the graph -------------------------------
  for (const org of SEED_ORGS) {
    await database
      .insert(organizations)
      .values({
        id: org.id,
        name: org.name,
        slug: org.slug,
        requireStepUpForReveal: org.requireStepUpForReveal,
        requireMfa: org.requireMfa,
        ssoOnly: org.ssoOnly,
      })
      .onConflictDoUpdate({
        target: organizations.id,
        set: {
          name: org.name,
          slug: org.slug,
          requireStepUpForReveal: org.requireStepUpForReveal,
          requireMfa: org.requireMfa,
          ssoOnly: org.ssoOnly,
          updatedAt: new Date(),
        },
      })

    for (const m of org.members) {
      await database
        .insert(members)
        .values({ organizationId: org.id, userId: m.userId, role: m.role })
        .onConflictDoUpdate({
          target: [members.organizationId, members.userId],
          set: { role: m.role },
        })
    }

    for (const inv of org.invitations ?? []) {
      await database
        .insert(invitations)
        .values({
          organizationId: org.id,
          email: inv.email,
          role: inv.role,
          status: 'pending',
          inviterId: inv.inviterId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing()
    }

    // Workspace METADATA only — environments + items are phase 2 (the DO).
    for (const ws of org.workspaces) {
      await database
        .insert(workspaces)
        .values({
          id: ws.id,
          organizationId: org.id,
          name: ws.name,
          slug: ws.slug,
          aiIndexingEnabled: ws.aiIndexingEnabled ?? true,
        })
        .onConflictDoUpdate({
          target: workspaces.id,
          set: { name: ws.name, slug: ws.slug, updatedAt: new Date() },
        })
    }

    // Enterprise SSO (OIDC) — client secret is envelope-encrypted by org id.
    if (org.sso && masterKek) {
      const envelope = await encryptSecret(masterKek, org.id, org.sso.clientSecret)
      await database
        .insert(ssoConnections)
        .values({
          organizationId: org.id,
          provider: 'oidc',
          issuer: org.sso.issuer,
          clientId: org.sso.clientId,
          encryptedClientSecret: JSON.stringify(envelope),
          redirectUri: org.sso.redirectUri,
        })
        .onConflictDoUpdate({
          target: ssoConnections.organizationId,
          set: {
            issuer: org.sso.issuer,
            clientId: org.sso.clientId,
            encryptedClientSecret: JSON.stringify(envelope),
            redirectUri: org.sso.redirectUri,
            updatedAt: new Date(),
          },
        })
    }

    // SAML — IdP cert is a public key, stored as-is.
    if (org.saml) {
      await database
        .insert(samlConnections)
        .values({ organizationId: org.id, ...org.saml })
        .onConflictDoUpdate({
          target: samlConnections.organizationId,
          set: { ...org.saml, updatedAt: new Date() },
        })
    }

    // SCIM — only the bearer token hash is stored.
    if (org.scimToken) {
      const tokenHash = hashToken(org.scimToken)
      await database
        .insert(scimConnections)
        .values({ organizationId: org.id, tokenHash })
        .onConflictDoUpdate({
          target: scimConnections.organizationId,
          set: { tokenHash, updatedAt: new Date() },
        })
    }

    // Custom domains (Cloudflare for SaaS hostnames).
    for (const d of org.customDomains ?? []) {
      await database
        .insert(customDomains)
        .values({
          id: d.id,
          organizationId: org.id,
          hostname: d.hostname,
          cfCustomHostnameId: d.cfCustomHostnameId,
          status: d.status,
          createdByUserId: d.createdByUserId,
        })
        .onConflictDoUpdate({
          target: customDomains.id,
          set: { status: d.status, updatedAt: new Date() },
        })
    }

    // Billing identity — presence makes the org "billed" with a plan tier.
    if (org.stripeCustomerId) {
      await database
        .insert(stripeCustomers)
        .values({ organizationId: org.id, stripeCustomerId: org.stripeCustomerId, plan: org.plan })
        .onConflictDoUpdate({
          target: stripeCustomers.organizationId,
          set: { stripeCustomerId: org.stripeCustomerId, plan: org.plan, updatedAt: new Date() },
        })
    }
  }

  // Usage-metering high-water mark for the billing cron (one row, 'audit').
  await database
    .insert(stripeMeterWatermarks)
    .values({ source: 'audit', watermark: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    .onConflictDoUpdate({
      target: stripeMeterWatermarks.source,
      set: { watermark: new Date(Date.now() - 24 * 60 * 60 * 1000), updatedAt: new Date() },
    })

  const orgCount = SEED_ORGS.length
  const wsCount = SEED_ORGS.reduce((n, o) => n + o.workspaces.length, 0)
  console.log('Phase 1 (Postgres) seeded:')
  console.log(
    `  primary login:  ${primaryEmail} / ${primaryPassword}  (owner of all ${orgCount} orgs)`,
  )
  console.log(`  users:          ${SEED_USERS.length}`)
  console.log(`  orgs:           ${SEED_ORGS.map((o) => `${o.name} (${o.plan})`).join(', ')}`)
  console.log(`  workspaces:     ${wsCount} (metadata only — content comes from phase 2)`)
  console.log('\nNext: start `pnpm dev`, then run `pnpm seed:dev` to fill environments,')
  console.log('configs, flags, secrets, content, API keys, and channels into the Vault DO + KV.')
} finally {
  await close()
}
