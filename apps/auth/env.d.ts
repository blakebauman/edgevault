// Augments the wrangler-generated `Env` with secret-provided values that are not
// declared in wrangler.jsonc `vars` (provided via .dev.vars locally / Secrets
// Store in production).
interface Env {
  /** EdDSA private signing key as a JWK JSON string (JWT_PRIVATE_JWK secret). */
  JWT_PRIVATE_JWK: string
  /** Shared secret authenticating internal callers (ee/enterprise SSO provisioning). */
  INTERNAL_TOKEN: string
  /** Base64 master key for envelope-encrypting TOTP secrets (@edgevault/crypto). */
  MASTER_KEK: string
}
