import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organization'

/**
 * Per-organization SAML 2.0 connection (one per org). The IdP X.509 certificate
 * is a public key, so unlike the OIDC client secret it is stored as-is (no
 * envelope encryption). Read/written only by the ee/enterprise worker.
 */
export const samlConnections = pgTable('saml_connections', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  idpEntityId: text('idp_entity_id').notNull(),
  idpSsoUrl: text('idp_sso_url').notNull(),
  /** IdP signing certificate (PEM or bare base64 X.509); public. */
  idpCertificate: text('idp_certificate').notNull(),
  /** Our SP entityID (the assertion audience). */
  spEntityId: text('sp_entity_id').notNull(),
  /** Our Assertion Consumer Service URL (where the IdP POSTs the response). */
  acsUrl: text('acs_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One-time-use record for consumed SAML assertion IDs (replay protection). The
 * assertion ID is the primary key, so the first successful insert wins and any
 * replay of the same assertion within its validity window fails the unique
 * constraint. Rows are pruned once `expiresAt` (the assertion's NotOnOrAfter)
 * has passed — an expired assertion is already rejected by the time-window check.
 */
export const samlAssertionReplay = pgTable('saml_assertion_replay', {
  assertionId: text('assertion_id').primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
})
