// Secret/optional binding values not declared in wrangler.jsonc `vars` (.dev.vars
// locally / Secrets Store in production). Augment `__BaseEnv_Env` — the base both
// the global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI).
interface __BaseEnv_Env {
  /** Shared secret authenticating this BFF to the auth + api internal endpoints. */
  INTERNAL_TOKEN: string
  /**
   * Managed-Edge control plane (proprietary edge/control-plane) hosting the
   * Stripe Checkout/Portal billing surface. Bound only on the hosted SaaS; the
   * billing page degrades gracefully (self-host) without it.
   */
  BILLING_SERVICE?: Fetcher
}
