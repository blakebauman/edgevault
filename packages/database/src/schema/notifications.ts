import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth'
import { workspaces } from './workspace'

export type NotificationChannelType = 'webhook' | 'slack'

/**
 * Per-workspace notification channels (generic signed webhooks + Slack incoming
 * webhooks). The destination URL and the webhook signing secret are stored as a
 * single envelope-encrypted blob (JSON of the @edgevault/crypto SecretEnvelope,
 * keyed by the workspace id) — webhook URLs are credentials. The api worker
 * decrypts at dispatch time and enqueues fully-materialized delivery jobs so the
 * notify consumer never touches Postgres.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationChannelType>().notNull(),
    name: text('name').notNull(),
    /** JSON string of the encrypted SecretEnvelope for `{ url, secret? }`. */
    encryptedCredentials: text('encrypted_credentials').notNull(),
    /** Event actions this channel receives; null or empty = all events. */
    events: jsonb('events').$type<string[]>(),
    enabled: boolean('enabled').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_channels_workspace_idx').on(t.workspaceId)],
)
