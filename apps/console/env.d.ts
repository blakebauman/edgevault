// Secret/optional binding values not declared in wrangler.jsonc `vars` (.dev.vars
// locally / Secrets Store in production). Augment `__BaseEnv_Env` — the base both
// the global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI).
interface __BaseEnv_Env {
  /** Shared secret authenticating this BFF to the auth + enterprise internal endpoints. */
  INTERNAL_TOKEN: string
  /**
   * Enterprise SSO worker (commercial ee/enterprise). Bound only in EE/Managed
   * Edge deployments; the SSO/SAML routes guard on its presence, so it is
   * optional in the OSS core configuration.
   */
  ENTERPRISE_SERVICE?: Fetcher
  /**
   * Managed-Edge control plane (proprietary edge/control-plane) hosting the
   * Stripe Checkout/Portal billing surface. Bound only on the hosted SaaS; the
   * billing page degrades gracefully (self-host = license keys) without it.
   */
  BILLING_SERVICE?: Fetcher
}
