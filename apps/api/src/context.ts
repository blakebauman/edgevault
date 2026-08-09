import type { Database } from '@edgevault/database'

export type AppEnv = {
  Bindings: Env
  Variables: {
    database: Database
    /** Authenticated user id (JWT `sub`), set by requireAuth. */
    userId: string
    /** Organization in scope: from the token, or the workspace's org. */
    orgId: string | null
    /** The caller's role in the workspace's org (owner/admin/member), if resolved. */
    role: string | null
    /**
     * How the caller authenticated (`pwd` | `sso`, plus `mfa` when a second
     * factor is on the account), from the token's `amr` claim. Org security
     * policies are checked against this.
     */
    amr: string[]
  }
}
