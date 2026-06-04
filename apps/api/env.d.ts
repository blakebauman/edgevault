// Secret-provided values not declared in wrangler.jsonc vars (.dev.vars locally,
// Secrets Store in production).
interface Env {
  /** Base64 master key for envelope encryption of customer secrets. */
  MASTER_KEK: string
}
