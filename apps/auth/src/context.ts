import type { Database } from '@edgevault/database'

export type AppEnv = {
  Bindings: Env
  Variables: {
    database: Database
  }
}
