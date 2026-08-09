import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { textModel } from '../ai'

/**
 * Which model the assistant talks to.
 *
 * Workers AI is the default and the only one configured out of the box: the
 * MIT core is meant to run on a Cloudflare account and nothing else, so
 * reaching for a third-party key must be a deliberate act, never a silent
 * requirement. `chatModel` picks Anthropic only when an operator has set
 * ANTHROPIC_API_KEY as a secret — absent that, behaviour is exactly what it
 * was before this file existed.
 *
 * Worth knowing if you switch: several workarounds in agent.ts exist because
 * llama-4-scout is weak at tool use (the anti-leak paragraph in the system
 * prompt, the `stopWhen` floor). They are harmless on a stronger model, but
 * they are also the reason the Workers AI path works at all — don't remove
 * them while it is still the default.
 */

/**
 * Operator-set overrides, all optional.
 *
 * Declared here rather than in wrangler.jsonc: an API key must never be a
 * plaintext var, and vars are what `wrangler types` generates `Env` from. These
 * arrive as secrets (`wrangler secret put`) or .dev.vars, so the generated Env
 * doesn't know them and this is where they get a type.
 */
type ProviderEnv = Env & {
  /** Set to route chat through Anthropic instead of Workers AI. */
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  /** Required alongside AI_GATEWAY_ID to proxy Anthropic through AI Gateway. */
  AI_GATEWAY_ACCOUNT_ID?: string
}

/** AI Gateway config, shared with the embedding/risk path in ../ai.ts. */
function gateway(env: Env): { id: string } | undefined {
  return env.AI_GATEWAY_ID ? { id: env.AI_GATEWAY_ID } : undefined
}

/**
 * The model for a chat turn.
 *
 * Both branches route through AI Gateway when AI_GATEWAY_ID is set. That was
 * previously true only of embeddings and risk scoring — `createWorkersAI` takes
 * the binding directly and so bypassed `aiRunner`, which is why chat turns
 * contributed nothing to gateway logs, caching, or token accounting.
 */
export function chatModel(env: Env): LanguageModel {
  const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL, AI_GATEWAY_ACCOUNT_ID } = env as ProviderEnv
  if (ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({
      apiKey: ANTHROPIC_API_KEY,
      // Gateway proxying for a third-party provider is a base-URL swap, unlike
      // the binding's `gateway` option. Needs the account id too, so fall back
      // to talking to Anthropic directly when only one of the two is set.
      ...(AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID
        ? {
            baseURL: `https://gateway.ai.cloudflare.com/v1/${AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`,
          }
        : {}),
    })
    return anthropic(ANTHROPIC_MODEL || 'claude-sonnet-4-6')
  }

  const workersai = createWorkersAI({ binding: env.AI, gateway: gateway(env) })
  return workersai(textModel(env) as Parameters<typeof workersai>[0])
}

/** Which provider `chatModel` will pick — for logs and tests, not for branching. */
export function activeProvider(env: Env): 'anthropic' | 'workers-ai' {
  return (env as ProviderEnv).ANTHROPIC_API_KEY ? 'anthropic' : 'workers-ai'
}

/**
 * Whether the configured model can be trusted with a multi-field structured
 * tool call — the shape the proposal tools need.
 *
 * Measured, not assumed. On staging, llama-4-scout failed `proposeChange` on
 * every attempt across three schema revisions: invalid tool input, then
 * mangled JSON-inside-JSON escaping with a truncated argument, and finally
 * printing the call as literal text instead of invoking it. The single-argument
 * read tools work reliably on the same model.
 *
 * So the proposal tools are only offered where they work. A Workers AI
 * deployment gets a read-only assistant that is honest about what it can do,
 * rather than a button that fails three different ways — which matters most for
 * self-hosters, since running on a Cloudflare account alone is the default.
 *
 * Phrased as a capability rather than `=== 'anthropic'` so adding a provider is
 * a question about that provider, not an edit to every call site.
 */
export function supportsStructuredTools(env: Env): boolean {
  return activeProvider(env) === 'anthropic'
}
