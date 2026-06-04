// Augments the wrangler-generated `Env` with secret-provided values that are not
// declared in wrangler.jsonc `vars` (provided via .dev.vars locally / Secrets
// Store in production).
interface Env {
  /** EdDSA private signing key as a JWK JSON string (JWT_PRIVATE_JWK secret). */
  JWT_PRIVATE_JWK: string
}
