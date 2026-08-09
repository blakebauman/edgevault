import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

/**
 * Roles within an organization, least privilege first.
 *
 * `viewer` reads and cannot write anything — the answer to "does this support
 * read-only access", which every security questionnaire asks. Before it, the
 * lowest role was `member`, which could write to every environment including
 * production; an auditor, a contractor, or a dashboard user had no seat that
 * fit them.
 *
 * Declared last, which is also how Postgres appends it. That happens to be
 * right: enum sort order follows declaration, so the ordinal now runs from
 * most to least privileged (owner → viewer) and any ordered comparison reads
 * the way you would expect.
 *
 * Finer-grained, environment- and key-scoped permissions are ROADMAP §2.10;
 * this is the down payment, not the destination.
 */
export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer'])
export const invitationStatus = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
])

/** Tenant root. Organizations own workspaces, members, and billing state. */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    image: text('image'),
    // Step-up policy: when true, revealing a secret requires a fresh second
    // factor (passkey/TOTP) — being signed in isn't enough. ON by default for
    // new orgs (the secure default a secrets platform should ship); existing
    // orgs keep their stored value and see a console nudge instead.
    requireStepUpForReveal: boolean('require_step_up_for_reveal').notNull().default(true),
    // Org security policies, enforced where org context enters a credential
    // (/token in the auth worker): members without a confirmed second factor
    // are refused org tokens when requireMfa is set; sessions not established
    // through the org's IdP are refused when ssoOnly is set.
    requireMfa: boolean('require_mfa').notNull().default(false),
    ssoOnly: boolean('sso_only').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
)

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    /**
     * Set when the membership is suspended rather than deleted — how SCIM
     * deprovisioning lands (`PATCH {"active": false}`), which every IdP sends
     * before it ever sends a DELETE.
     *
     * A deactivated row is not a member: role resolution ignores it, so access
     * stops immediately. The row survives so the directory can still answer
     * `GET /Users/:id` with `active: false` (IdPs read back what they wrote),
     * and so reactivation restores the original role instead of guessing one.
     */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('members_org_user_key').on(t.organizationId, t.userId),
    index('members_user_id_idx').on(t.userId),
  ],
)

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: memberRole('role').notNull().default('member'),
    status: invitationStatus('status').notNull().default('pending'),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invitations_org_email_idx').on(t.organizationId, t.email)],
)
