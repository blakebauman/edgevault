import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { organizations } from './organization'

/**
 * Workspace METADATA only. Environments and the actual config/secret/flag DATA
 * are the system of record inside the per-workspace SQLite Durable Object
 * (Phase 2). Postgres holds the org→workspace mapping (for membership authz)
 * and API-key hashes (for edge validation). Environment ids referenced here are
 * opaque ids minted by the Durable Object — there is intentionally no Neon
 * `environments` table.
 */

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // When false, config content is never embedded into Vectorize or sent to
    // AI search — semantic search degrades to disabled for this workspace.
    aiIndexingEnabled: boolean('ai_indexing_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspaces_org_slug_key').on(t.organizationId, t.slug)],
)

/**
 * NOTE: environments are managed by the workspace Durable Object (system of
 * record). This table is retained but unused; api_keys reference the DO-minted
 * environment id directly (no FK). A later migration can drop it.
 */
export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('environments_workspace_slug_key').on(t.workspaceId, t.slug)],
)

/**
 * Environment-scoped API keys for the edge delivery path. We store only the
 * SHA-256 `keyHash`; `prefix` (e.g. `evk_live_ab12`) is shown to identify keys.
 * `environmentId` is the DO-minted environment id (opaque, no Neon FK).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    // Optional source-IP restriction (CIDR list). Empty/null = any IP.
    allowedCidrs: jsonb('allowed_cidrs').$type<string[]>(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
    index('api_keys_workspace_id_idx').on(t.workspaceId),
    index('api_keys_environment_id_idx').on(t.environmentId),
    index('api_keys_prefix_idx').on(t.prefix),
  ],
)
