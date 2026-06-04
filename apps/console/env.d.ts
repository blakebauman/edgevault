// Augments the wrangler-generated `Env` with secret-provided values not declared
// in wrangler.jsonc `vars` (provided via .dev.vars locally / Secrets Store in
// production).
interface Env {
  /** Shared secret authenticating this BFF to the auth + enterprise internal endpoints. */
  INTERNAL_TOKEN: string
}
