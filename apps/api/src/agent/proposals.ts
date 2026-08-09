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
