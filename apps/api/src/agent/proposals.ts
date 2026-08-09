import type { AssistantProposal } from '@edgevault/edge-protocol'
import { CONFIG_KEY_PATTERN, MAX_CONFIG_KEY_LENGTH } from '@edgevault/edge-protocol'
import { z } from 'zod'

/**
 * Zod mirror of the assistant-proposal contract in @edgevault/edge-protocol.
 *
 * The contract itself is a plain type because edge-protocol has no runtime
 * dependencies (it's the wire vocabulary, imported by every worker). Validation
 * lives here, where zod already does. `satisfies` below is what keeps the two
 * from drifting: if the schema stops producing a valid `AssistantProposal`, or
 * the contract gains a field this doesn't parse, the build fails.
 */

// Same key constraint the write routes enforce, so the model can't propose a
// key that would be rejected on apply.
const keySchema = z.string().min(1).max(MAX_CONFIG_KEY_LENGTH).regex(CONFIG_KEY_PATTERN)

const rationale = z
  .string()
  .min(1)
  .max(500)
  .describe('one or two sentences on why this change is right')

export const configChangeProposalSchema = z.object({
  kind: z.literal('config-change'),
  environmentId: z.string().min(1).describe('the environment to write to'),
  key: keySchema,
  // Deliberately no 'secret'. A proposal is rendered in the thread and stored
  // in the agent's message history, so a secret value proposed here would be
  // persisted in plaintext outside the vault — the exact thing envelope
  // encryption exists to prevent. Secrets are set in the console.
  itemKind: z.enum(['config', 'flag', 'content']),
  contentType: z.string().max(64).optional(),
  content: z.string().max(64_000).describe('the full new value, not a diff'),
  rationale,
})

export const promotionProposalSchema = z.object({
  kind: z.literal('promotion'),
  sourceEnvironmentId: z.string().min(1),
  targetEnvironmentId: z.string().min(1),
  key: keySchema,
  rationale,
})

export const assistantProposalSchema = z.discriminatedUnion('kind', [
  configChangeProposalSchema,
  promotionProposalSchema,
])

// Compile-time drift check against the shared contract (see the header).
type SchemaOutput = z.infer<typeof assistantProposalSchema>
const _contractCheck = {} as SchemaOutput satisfies AssistantProposal

/**
 * What the *model* is asked for, as opposed to what goes on the wire.
 *
 * Two deliberate differences from the schemas above, both learned from watching
 * llama-4-scout fail this call five times in a row on staging:
 *
 *  - No `kind`. It is a constant implied by the tool name, so requiring the
 *    model to reproduce the exact literal adds a way to fail and no information.
 *    `execute` stamps it back on.
 *  - `rationale` is optional here. A missing sentence of justification is not a
 *    reason to throw away an otherwise valid proposal; `execute` supplies a
 *    neutral default so the card still has something to show.
 *
 * Everything that protects an invariant — the key pattern, the exclusion of
 * secrets, the length caps — stays strict. The rule is to be lenient about the
 * model's phrasing and strict about what actually matters.
 */
/**
 * Config values are usually JSON, and the wire contract carries them as a
 * string. Demanding a string from the model means demanding correctly
 * double-escaped JSON-inside-JSON — `"{\"ms\":3000}"` — which llama-4-scout
 * reliably mangles; on staging it emitted `"{\"\s\":3000}"` and truncated the
 * argument mid-value on three consecutive attempts, then gave up and described
 * the change in prose instead.
 *
 * Accepting a structured value removes the escaping problem rather than asking
 * the model to be better at it: it can send the object itself, and
 * `toConfigChangeProposal` serializes. A string is still accepted for
 * non-JSON content types.
 */
const modelContent = z
  .union([z.string().max(64_000), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe('the full new value — send JSON as an object, not an escaped string')

export const configChangeToolInput = configChangeProposalSchema
  .omit({ kind: true, rationale: true, content: true })
  .extend({ rationale: rationale.optional(), content: modelContent })

export const promotionToolInput = promotionProposalSchema
  .omit({ kind: true, rationale: true })
  .extend({ rationale: rationale.optional() })

const DEFAULT_RATIONALE = 'Proposed by the assistant.'

/** Rebuild the full wire proposal from what the model supplied. */
export function toConfigChangeProposal(
  input: z.infer<typeof configChangeToolInput>,
): AssistantProposal {
  return {
    ...input,
    kind: 'config-change',
    // Pretty-printed rather than compact: the card shows this verbatim in a
    // before/after diff, and a human is about to approve it.
    content:
      typeof input.content === 'string' ? input.content : JSON.stringify(input.content, null, 2),
    rationale: input.rationale || DEFAULT_RATIONALE,
  }
}

export function toPromotionProposal(input: z.infer<typeof promotionToolInput>): AssistantProposal {
  return { ...input, kind: 'promotion', rationale: input.rationale || DEFAULT_RATIONALE }
}
