import type { Database } from '@edgevault/database'

export type AppEnv = {
  Bindings: Env
  Variables: {
    database: Database
    /** Set by requireUser for access-token-authenticated routes (MFA management). */
    userId: string
  }
}
