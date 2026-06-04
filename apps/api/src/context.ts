import type { Database } from '@edgevault/database'

export type AppEnv = {
  Bindings: Env
  Variables: {
    database: Database
    /** Authenticated user id (JWT `sub`), set by requireAuth. */
    userId: string
    /** Organization in scope: from the token, or the workspace's org. */
    orgId: string | null
  }
}
