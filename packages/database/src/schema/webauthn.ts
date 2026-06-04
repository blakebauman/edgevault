import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth'

/**
 * A registered WebAuthn/passkey authenticator. `id` is the credential ID
 * (Base64URL); `publicKey` is the COSE public key (Base64URL of the bytes).
 * `counter` is the authenticator's signature counter — persisted and advanced on
 * each login to detect cloned authenticators (replay).
 */
export const authenticators = pgTable('authenticators', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
