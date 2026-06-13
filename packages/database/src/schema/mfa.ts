import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth'

/**
 * Per-user TOTP credential. The shared secret is envelope-encrypted (keyed by
 * user id) before storage — never plaintext. `confirmedAt` stays null between
 * "start enrollment" and the first verified code; only confirmed credentials
 * gate sign-in, so an abandoned setup never locks anyone out.
 */
export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedSecret: text('encrypted_secret').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  // Replay guard: the highest RFC 6238 counter step already accepted. A code
  // verifies once — replays within the ±1-step drift window are rejected.
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One-time MFA recovery codes, generated at TOTP enrollment. Only SHA-256
 * hashes are stored; each code is consumed by setting `usedAt` (atomic
 * conditional UPDATE — double submits race to one winner).
 */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recovery_codes_user_id_idx').on(t.userId)],
)
