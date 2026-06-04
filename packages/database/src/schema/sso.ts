import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organization'

/**
 * Per-organization enterprise SSO connection (one per org for now). The OIDC
 * client secret is stored as an envelope-encrypted blob (JSON of the
 * @edgevault/crypto SecretEnvelope, keyed by the org id) — never in plaintext.
 * Read/written only by the ee/enterprise worker; the MIT core never touches it.
 */
export const ssoConnections = pgTable('sso_connections', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('oidc'),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  /** JSON string of the encrypted SecretEnvelope for the OIDC client secret. */
  encryptedClientSecret: text('encrypted_client_secret').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default(['openid', 'email', 'profile']),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
