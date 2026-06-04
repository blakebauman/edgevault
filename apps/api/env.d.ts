// Secret-provided values not declared in wrangler.jsonc vars (.dev.vars locally,
// Secrets Store in production). Augment `__BaseEnv_Env` — the base that both the
// global `Env` and `Cloudflare.Env` extend — so the types hold even when
// `cf-typegen` runs without .dev.vars present (e.g. CI, where secrets aren't on
// disk and so aren't picked up into the generated bindings).
interface __BaseEnv_Env {
  /** Base64 master key for envelope encryption of customer secrets. */
  MASTER_KEK: string
}
