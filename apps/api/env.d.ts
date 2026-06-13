// Secret-provided values not declared in wrangler.jsonc vars (.dev.vars locally,
// Secrets Store in production). Augment `__BaseEnv_Env` — the base that both the
// global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI, where secrets aren't on
// disk and so aren't picked up into the generated bindings).
interface __BaseEnv_Env {
  /** Base64 master key for envelope encryption of customer secrets. */
  MASTER_KEK: string
  /**
   * Shared secret authenticating trusted internal workers (the console BFF) on
   * the /internal/* surface — same token the auth/enterprise workers hold.
   */
  INTERNAL_TOKEN: string
  /**
   * Workers Rate Limiting bindings (wrangler.jsonc `ratelimits`). Optional here
   * so the vitest pool (wrangler.test.jsonc omits them) typechecks — the
   * rate-limit helpers fail open when a binding is absent.
   */
  MACHINE_IP_LIMITER?: RateLimit
  SHARE_IP_LIMITER?: RateLimit
  AI_USER_LIMITER?: RateLimit
  /**
   * Cloudflare for SaaS API token for custom delivery domains (zone-scoped,
   * Custom Hostnames Edit). Optional — absent (with CF_ZONE_ID empty) the
   * /domains routes 404 and the feature is off.
   */
  CF_SAAS_API_TOKEN?: string
}
