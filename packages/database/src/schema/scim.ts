import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organization'

/**
 * Per-organization SCIM 2.0 provisioning config (one per org). Holds the
 * SHA-256 hash of the org's SCIM bearer token (the secret the admin pastes into
 * their IdP) — the raw token is shown once at creation and never stored. A row
 * exists only once SCIM is configured; its presence authenticates the SCIM
 * surface in the api worker. Symmetric with `sso_connections` /
 * `saml_connections`.
 */
export const scimConnections = pgTable('scim_connections', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** SHA-256 (hex) of the SCIM provisioning bearer token. */
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
