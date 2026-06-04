// Secret-provided values not declared in wrangler.jsonc `vars` (.dev.vars locally
// / Secrets Store in production). Augment `__BaseEnv_Env` — the base both the
// global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI).
interface __BaseEnv_Env {
  /** EdDSA private signing key as a JWK JSON string (JWT_PRIVATE_JWK secret). */
  JWT_PRIVATE_JWK: string
  /** Shared secret authenticating internal callers (ee/enterprise SSO provisioning). */
  INTERNAL_TOKEN: string
  /** Base64 master key for envelope-encrypting TOTP secrets (@edgevault/crypto). */
  MASTER_KEK: string
  /** Social OAuth client credentials (optional; empty disables that provider). */
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}
