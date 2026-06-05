// Secrets provided via Secrets Store (not committed).
interface Env {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  /** Shared mesh secret: authenticates the console BFF to /billing/* (same
   * value as on auth/console/enterprise). */
  INTERNAL_TOKEN: string
}
