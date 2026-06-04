import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organization'

/**
 * Per-organization entitlements (the cloud source of truth). The Managed Edge
 * control plane upserts these from Stripe subscription events; api/auth read
 * them to gate enterprise features. Self-hosters instead present signed license
 * keys (@edgevault/licensing) — both converge on the same entitlement flags.
 */
export const entitlements = pgTable('entitlements', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull().default('free'),
  entitlements: jsonb('entitlements').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
