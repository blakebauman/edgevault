// Augments the wrangler-generated `Env` with secret-provided values not declared
// in wrangler.jsonc `vars` (provided via .dev.vars locally / Secrets Store in
// production).
interface Env {
  /** Base64 master key for envelope-encrypting OIDC client secrets (@edgevault/crypto). */
  MASTER_KEK: string
  /** Shared secret authenticating the console BFF when it calls the SSO surface. */
  INTERNAL_TOKEN: string
}
