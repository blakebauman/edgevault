import { AIChatAgent } from '@cloudflare/ai-chat'
import { searchConfigs } from '@edgevault/ai'
import { convertToModelMessages, stepCountIs, streamText, type ToolSet, tool } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import { aiRunner, embeddingModel, textModel, vectorize } from '../ai'
import type { VaultDurableObject } from '../durable-objects/vault'

/**
 * EdgeVault Agent — a per-workspace assistant grounded in the workspace's
 * activity log and config content.
 *
 * Built on the Agents SDK's `AIChatAgent`: `onChatMessage` streams chat over a
 * WebSocket with model-chosen tools and SDK-managed message persistence. The
 * agent instance name is `${workspaceId}` or `${workspaceId}:${userId}` — the
 * workspace id is its first segment.
 */
export class EdgeVaultAgent extends AIChatAgent<Env> {
  /** The workspace this agent instance serves (name is `wsId` or `wsId:userId`). */
  private get workspaceId(): string {
    return this.name.split(':')[0] ?? ''
  }

  /** Tools the model can call: semantic config search + recent activity. */
  private chatTools() {
    const workspaceId = this.workspaceId
    return {
      searchConfigs: tool({
        description:
          'Find config, flag, secret, or content items in this workspace by meaning. Use when the user is looking for a specific setting or value.',
        inputSchema: z.object({ query: z.string().describe('what to look for') }),
        execute: async ({ query }) => {
          try {
            const hits = await searchConfigs(
              {
                ai: aiRunner(this.env),
                vectorize: vectorize(this.env),
                embeddingModel: embeddingModel(this.env),
              },
              { workspaceId, query, topK: 5 },
            )
            return hits.map((h) => ({
              key: h.key,
              kind: h.kind,
              environmentId: h.environmentId,
              score: h.score,
            }))
          } catch {
            return []
          }
        },
      }),
      recentActivity: tool({
        description:
          'List recent configuration changes in this workspace (what changed and by whom).',
        inputSchema: z.object({ limit: z.number().int().max(25).optional() }),
        execute: async ({ limit }) => {
          const workspace = this.env.WORKSPACE.get(
            this.env.WORKSPACE.idFromName(workspaceId),
          ) as DurableObjectStub<VaultDurableObject>
          const events = await workspace.listActivity(limit ?? 25)
          return events.map((e) => ({
            action: e.action,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            at: e.createdAt,
          }))
        },
      }),
    }
  }

  /**
   * Streaming chat (Agents SDK). The model decides when to call the tools above;
   * messages are persisted by the SDK.
   */
  override async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0],
    options?: Parameters<AIChatAgent<Env>['onChatMessage']>[1],
  ): Promise<Response | undefined> {
    const workersai = createWorkersAI({ binding: this.env.AI })
    const result = streamText({
      model: workersai(textModel(this.env) as Parameters<typeof workersai>[0]),
      system:
        "You are EdgeVault's assistant for a single workspace. Use the searchConfigs tool to find items by meaning and the recentActivity tool for what changed and why. Cite items by key; be concise; never invent keys or values.",
      messages: await convertToModelMessages(this.messages),
      // Widened to ToolSet so streamText doesn't narrow onFinish past the
      // base-class callback signature; the executes run unchanged.
      tools: this.chatTools() as ToolSet,
      // Without this the model stops after the tool CALL (one step) and never
      // writes an answer from the results — the user sees only the tool output
      // ("Sources: …"). Let it loop tool → results → text (a few steps is ample
      // for our two read-only tools).
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onFinish,
      onError: ({ error }) => {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        const cause = (error as { cause?: unknown })?.cause
        console.error(
          'onChatMessage stream error:',
          detail,
          cause ? `| cause: ${JSON.stringify(cause)}` : '',
        )
      },
    })
    return result.toUIMessageStreamResponse()
  }
}
