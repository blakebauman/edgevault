import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export type Schema = typeof schema
export type Database = ReturnType<typeof drizzle<Schema>>

export interface DatabaseConnection {
  database: Database
  /**
   * Close the underlying pool. On Workers, call this via `ctx.waitUntil(...)`
   * after the response so the request isn't blocked on connection teardown.
   */
  close: () => Promise<void>
}

/**
 * Create a Drizzle client over a `pg` Pool. Pass `env.HYPERDRIVE.connectionString`
 * in a Worker (Hyperdrive does the cross-request pooling, so keep `max` small),
 * or a direct Postgres URL for scripts/tests.
 */
export function createDatabase(connectionString: string, max = 5): DatabaseConnection {
  const pool = new Pool({ connectionString, max })
  const database = drizzle(pool, { schema })
  return { database, close: () => pool.end() }
}
