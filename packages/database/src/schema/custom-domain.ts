import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { organizations } from './organization'

/**
 * Lifecycle of a Cloudflare-for-SaaS custom hostname: DCV (domain control
 * validation) → certificate issuance → active. `failed` is terminal (DCV
 * rejected, hostname moved/blocked, or verification timed out) — the row is
 * kept so the console can show why; the user deletes and re-adds.
 */
export const customDomainStatus = pgEnum('custom_domain_status', [
  'pending_dcv',
  'pending_ssl',
  'active',
  'failed',
])

/**
 * Customer-owned hostnames in front of the delivery plane (`config.acme.com`
 * CNAME → delivery host), provisioned via the Cloudflare for SaaS
 * custom-hostnames API. Pure transport: delivery tenancy still comes from the
 * environment-scoped API key; an active domain additionally writes a
 * `domain:{hostname}` → orgId pin to KV so delivery can reject keys from
 * other orgs presented on this hostname.
 */
export const customDomains = pgTable(
  'custom_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    /** Id of the custom hostname object at Cloudflare (`/zones/:z/custom_hostnames/:id`). */
    cfCustomHostnameId: text('cf_custom_hostname_id').notNull(),
    status: customDomainStatus('status').notNull().default('pending_dcv'),
    /** Why a `failed` domain failed (CF terminal status or `timeout`). */
    failureReason: text('failure_reason'),
    /** DCV validation records (TXT/HTTP) to surface in the console, verbatim from CF. */
    dcvRecords: jsonb('dcv_records'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('custom_domains_hostname_key').on(t.hostname),
    index('custom_domains_org_idx').on(t.organizationId),
  ],
)
