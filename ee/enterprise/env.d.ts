// Secret-provided values not declared in wrangler.jsonc `vars` (.dev.vars locally
// / Secrets Store in production). Augment `__BaseEnv_Env` — the base both the
// global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI).
interface __BaseEnv_Env {
  /** Base64 master key for envelope-encrypting OIDC client secrets (@edgevault/crypto). */
  MASTER_KEK: string
  /** Shared secret authenticating the console BFF when it calls the SSO surface. */
  INTERNAL_TOKEN: string
}
