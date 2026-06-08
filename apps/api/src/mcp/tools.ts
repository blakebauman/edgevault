import { searchConfigs } from '@edgevault/ai'
import { CONFIG_KEY_PATTERN, MAX_CONFIG_KEY_LENGTH } from '@edgevault/edge-protocol'
import { hasRefs } from '@edgevault/refs'
import { z } from 'zod'
import { aiRunner, embeddingModel, indexConfig, vectorize } from '../ai'
import { configChangeEvent, emitAudit, promoteEvent, revealEvent } from '../audit'
import type { ConfigItem } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'
import { publishTargets } from '../edge-cache'
import { dispatchNotifications } from '../notify'
import { prepareSecretContent, revealSecret } from '../secrets'
import { defineTool, type McpToolContext } from './server'

function stub(ctx: McpToolContext): DurableObjectStub<VaultDurableObject> {
  return ctx.env.WORKSPACE.get(ctx.env.WORKSPACE.idFromName(ctx.workspaceId))
}

function redact(item: ConfigItem): ConfigItem {
  return item.kind === 'secret' ? { ...item, content: '' } : item
}

function isAdmin(ctx: McpToolContext): boolean {
  return ctx.role === 'owner' || ctx.role === 'admin'
}

const kindEnum = ['config', 'flag', 'secret'] as const
// Same write-time key constraint as the HTTP routes (KV-key and ref safe).
const keySchema = z.string().min(1).max(MAX_CONFIG_KEY_LENGTH).regex(CONFIG_KEY_PATTERN)
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

/** EdgeVault MCP tools — scoped to the workspace in the request URL. */
export const edgevaultTools = [
  defineTool({
    name: 'list_environments',
    description: 'List the environments in this workspace.',
    inputSchema: objectSchema({}),
    schema: z.object({}),
    handler: async (_args, ctx) => stub(ctx).listEnvironments(),
  }),
  defineTool({
    name: 'list_configs',
    description: 'List config/flag/secret items in an environment. Secret values are redacted.',
    inputSchema: objectSchema(
      {
        environmentId: { type: 'string' },
        kind: { type: 'string', enum: kindEnum },
      },
      ['environmentId'],
    ),
    schema: z.object({
      environmentId: z.string(),
      kind: z.enum(kindEnum).optional(),
    }),
    handler: async (args, ctx) =>
      (await stub(ctx).listConfigs(args.environmentId, args.kind)).map(redact),
  }),
  defineTool({
    name: 'get_config',
    description: 'Get a single config/flag/secret by key. Secret values are redacted.',
    inputSchema: objectSchema({ environmentId: { type: 'string' }, key: { type: 'string' } }, [
      'environmentId',
      'key',
    ]),
    schema: z.object({ environmentId: z.string(), key: z.string() }),
    handler: async (args, ctx) => {
      const item = await stub(ctx).getConfig(args.environmentId, args.key)
      if (!item) return { error: 'not_found' }
      // Items with ${...} references also report their resolved (published) value.
      if (item.kind !== 'secret' && hasRefs(item.content)) {
        const { targets } = await stub(ctx).collectPublishTargets(args.environmentId, args.key, 1)
        return {
          ...redact(item),
          resolvedContent: targets[0]?.resolvedContent,
        }
      }
      return redact(item)
    },
  }),
  defineTool({
    name: 'set_config',
    description: 'Create or update a config/flag/secret value (records a new revision).',
    inputSchema: objectSchema(
      {
        environmentId: { type: 'string' },
        key: { type: 'string' },
        content: { type: 'string' },
        kind: { type: 'string', enum: kindEnum },
        contentType: { type: 'string' },
      },
      ['environmentId', 'key', 'content'],
    ),
    schema: z.object({
      environmentId: z.string(),
      key: keySchema,
      content: z.string(),
      kind: z.enum(kindEnum).optional(),
      contentType: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      const prepared = await prepareSecretContent(ctx.env, ctx.workspaceId, args.kind, args.content)
      const item = await stub(ctx).setConfig({
        environmentId: args.environmentId,
        key: args.key,
        content: prepared.content,
        isEncrypted: prepared.isEncrypted,
        kind: args.kind,
        contentType: args.contentType,
        userId: ctx.userId,
      })
      // Publish the item plus anything referencing it, with ${...} expanded.
      const { targets } = await stub(ctx).collectPublishTargets(item.environmentId, item.key)
      await publishTargets(ctx.env, ctx.workspaceId, targets)
      await indexConfig(ctx.env, ctx.workspaceId, item)
      // Same cold audit trail + notifications as the HTTP write surface.
      const changed = configChangeEvent({
        workspaceId: ctx.workspaceId,
        environmentId: item.environmentId,
        kind: item.kind,
        key: item.key,
        version: item.version,
        userId: ctx.userId,
      })
      await emitAudit(ctx.env, changed)
      await dispatchNotifications(ctx.env, changed)
      return redact(item)
    },
  }),
  defineTool({
    name: 'reveal_secret',
    description: 'Decrypt and return a secret value. Use sparingly. Requires an admin role.',
    inputSchema: objectSchema({ environmentId: { type: 'string' }, key: { type: 'string' } }, [
      'environmentId',
      'key',
    ]),
    schema: z.object({ environmentId: z.string(), key: z.string() }),
    handler: async (args, ctx) => {
      // Same privilege bar as the HTTP reveal endpoint — workspace membership
      // alone must never decrypt a secret.
      if (!isAdmin(ctx)) {
        return { error: 'forbidden', detail: 'revealing secrets requires admin' }
      }
      // Honor the org's step-up policy: an agent can't perform a passkey/TOTP
      // ceremony, so refuse rather than bypass — the human reveals in the console.
      if (ctx.requireStepUp) {
        return {
          error: 'reauth_required',
          detail:
            'This organization requires a fresh second factor to reveal secrets. Reveal it in the EdgeVault console.',
        }
      }
      const item = await stub(ctx).getConfig(args.environmentId, args.key)
      if (!item) return { error: 'not_found' }
      const content = await revealSecret(ctx.env, ctx.workspaceId, item)
      // Reveals always leave a cold audit trail, whichever surface they use.
      const revealed = revealEvent({
        workspaceId: ctx.workspaceId,
        environmentId: args.environmentId,
        kind: item.kind,
        key: item.key,
        userId: ctx.userId,
      })
      await emitAudit(ctx.env, revealed)
      await dispatchNotifications(ctx.env, revealed)
      return { key: item.key, content }
    },
  }),
  defineTool({
    name: 'promote_config',
    description: 'Promote a config from a source environment to a target environment.',
    inputSchema: objectSchema(
      {
        sourceEnvironmentId: { type: 'string' },
        targetEnvironmentId: { type: 'string' },
        key: { type: 'string' },
      },
      ['sourceEnvironmentId', 'targetEnvironmentId', 'key'],
    ),
    schema: z.object({
      sourceEnvironmentId: z.string(),
      targetEnvironmentId: z.string(),
      key: keySchema,
    }),
    handler: async (args, ctx) => {
      const promotion = await stub(ctx).promote({
        ...args,
        userId: ctx.userId,
      })
      const { targets } = await stub(ctx).collectPublishTargets(args.targetEnvironmentId, args.key)
      await publishTargets(ctx.env, ctx.workspaceId, targets)
      const target = await stub(ctx).getConfig(args.targetEnvironmentId, args.key)
      const promoted = promoteEvent({
        workspaceId: ctx.workspaceId,
        targetEnvironmentId: args.targetEnvironmentId,
        kind: target?.kind,
        key: args.key,
        userId: ctx.userId,
      })
      await emitAudit(ctx.env, promoted)
      await dispatchNotifications(ctx.env, promoted)
      return promotion
    },
  }),
  defineTool({
    name: 'compare_environments',
    description:
      'Compare two environments key-by-key (equal / drifted / only-in-one). Secrets compare by presence only; values are never decrypted.',
    inputSchema: objectSchema(
      {
        sourceEnvironmentId: { type: 'string' },
        targetEnvironmentId: { type: 'string' },
      },
      ['sourceEnvironmentId', 'targetEnvironmentId'],
    ),
    schema: z.object({
      sourceEnvironmentId: z.string(),
      targetEnvironmentId: z.string(),
    }),
    handler: async (args, ctx) =>
      stub(ctx).compareEnvironments(args.sourceEnvironmentId, args.targetEnvironmentId),
  }),
  defineTool({
    name: 'search_configs',
    description: 'Semantic search over the workspace configs; returns ranked keys.',
    inputSchema: objectSchema({ query: { type: 'string' }, environmentId: { type: 'string' } }, [
      'query',
    ]),
    schema: z.object({
      query: z.string(),
      environmentId: z.string().optional(),
    }),
    handler: async (args, ctx) =>
      searchConfigs(
        {
          ai: aiRunner(ctx.env),
          vectorize: vectorize(ctx.env),
          embeddingModel: embeddingModel(ctx.env),
        },
        {
          workspaceId: ctx.workspaceId,
          query: args.query,
          environmentId: args.environmentId,
          topK: 10,
        },
      ),
  }),
  defineTool({
    name: 'get_activity',
    description: 'Recent activity (audit trail) for this workspace.',
    inputSchema: objectSchema({}),
    schema: z.object({}),
    handler: async (_args, ctx) => stub(ctx).listActivity(),
  }),
]
