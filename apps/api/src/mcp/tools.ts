import { searchConfigs } from '@edgevault/ai'
import { z } from 'zod'
import { aiRunner, embeddingModel, indexConfig, vectorize } from '../ai'
import type { ConfigItem } from '../durable-objects/types'
import type { WorkspaceDurableObject } from '../durable-objects/workspace'
import { writeThrough } from '../edge-cache'
import { defineTool, type McpToolContext } from './server'

function stub(ctx: McpToolContext): DurableObjectStub<WorkspaceDurableObject> {
  return ctx.env.WORKSPACE.get(ctx.env.WORKSPACE.idFromName(ctx.workspaceId))
}

function redact(item: ConfigItem): ConfigItem {
  return item.kind === 'secret' ? { ...item, content: '' } : item
}

const kindEnum = ['config', 'flag', 'secret'] as const
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
      { environmentId: { type: 'string' }, kind: { type: 'string', enum: kindEnum } },
      ['environmentId'],
    ),
    schema: z.object({ environmentId: z.string(), kind: z.enum(kindEnum).optional() }),
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
      return item ? redact(item) : { error: 'not_found' }
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
      key: z.string(),
      content: z.string(),
      kind: z.enum(kindEnum).optional(),
      contentType: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      const item = await stub(ctx).setConfig({
        environmentId: args.environmentId,
        key: args.key,
        content: args.content,
        kind: args.kind,
        contentType: args.contentType,
        userId: ctx.userId,
      })
      await writeThrough(ctx.env, ctx.workspaceId, item)
      await indexConfig(ctx.env, ctx.workspaceId, item)
      return redact(item)
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
      key: z.string(),
    }),
    handler: async (args, ctx) => {
      const promotion = await stub(ctx).promote({ ...args, userId: ctx.userId })
      const target = await stub(ctx).getConfig(args.targetEnvironmentId, args.key)
      if (target) await writeThrough(ctx.env, ctx.workspaceId, target)
      return promotion
    },
  }),
  defineTool({
    name: 'search_configs',
    description: 'Semantic search over the workspace configs; returns ranked keys.',
    inputSchema: objectSchema({ query: { type: 'string' }, environmentId: { type: 'string' } }, [
      'query',
    ]),
    schema: z.object({ query: z.string(), environmentId: z.string().optional() }),
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
