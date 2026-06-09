import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organization'

/**
 * Managed-Edge billing identity: which Stripe customer pays for an org. The
 * control plane upserts this from `customer.subscription.*` webhook events
 * (the subscription carries `metadata.organizationId`; `customer` is the Stripe
 * id), and the usage-metering cron reads it to attribute meter events. Orgs
 * without a row are unbilled (free tier / self-host) and are skipped by the
 * cron. `plan` is the org's coarse subscription tier (free/pro/team/enterprise)
 * for billing display — there is no feature-gating attached to it; every feature
 * is core. The table lives in the shared schema so a single Neon database serves
 * both the OSS core and the proprietary control plane.
 */
export const stripeCustomers = pgTable(
  'stripe_customers',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    plan: text('plan').notNull().default('free'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('stripe_customers_customer_id_key').on(t.stripeCustomerId)],
)

/**
 * High-water mark for the usage-metering cron: everything before `watermark`
 * has been fully reported to Stripe Billing Meters. The cron only advances it
 * after Stripe accepts every event for the window, so a partial failure replays
 * the window on the next run (per-hour event `identifier`s make the replay
 * idempotent on Stripe's side). One row per metering source ('audit' today).
 */
export const stripeMeterWatermarks = pgTable('stripe_meter_watermarks', {
  source: text('source').primaryKey(),
  watermark: timestamp('watermark', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
