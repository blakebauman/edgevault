import { AIChatAgent } from '@cloudflare/ai-chat'
import { searchConfigs } from '@edgevault/ai'
import { convertToModelMessages, stepCountIs, streamText, type ToolSet, tool } from 'ai'
import { z } from 'zod'
import { aiRunner, embeddingModel, vectorize } from '../ai'
import { aiProposalEvent, aiRateLimitedEvent, emitAudit } from '../audit'
import type { VaultDurableObject } from '../durable-objects/vault'
import { checkRateLimit } from '../rate-limit'
import {
  configChangeToolInput,
  promotionToolInput,
  toConfigChangeProposal,
  toPromotionProposal,
} from './proposals'
import { chatModel, supportsStructuredTools } from './providers'
import { RATE_LIMITED_MESSAGE, refusalResponse } from './refusal'

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

  /**
   * The user this thread belongs to, from the second name segment.
   *
   * Read off the name rather than remembered from `onConnect`: a message on an
   * already-persisted socket wakes a hibernated DO *without* re-firing
   * `onConnect`, so an instance field would be empty exactly when a long-idle
   * thread resumes. The name is set at construction and survives hibernation.
   * `/agents/*` has already checked this segment against the authenticated
   * caller (apps/api/src/index.ts), so it is trustworthy here.
   */
  private get userId(): string {
    return this.name.split(':')[1] ?? ''
  }

  /** RPC stub for this workspace's vault DO (the config system of record). */
  private workspace(): DurableObjectStub<VaultDurableObject> {
    return this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(this.workspaceId),
    ) as DurableObjectStub<VaultDurableObject>
  }

  /**
   * Tools the model can call.
   *
   * Read tools execute for real; the two `propose*` tools deliberately do not
   * write — they hand a structured suggestion to the client, which applies it
   * through the ordinary authorized console path if the user approves.
   */
  private chatTools() {
    const workspaceId = this.workspaceId
    const readTools = {
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
      getConfig: tool({
        description:
          'Read one item by environment and exact key, including its current value. Use before proposing a change so the proposal is based on what is actually there. Secret values are never returned.',
        inputSchema: z.object({
          environmentId: z.string().describe('the environment id'),
          key: z.string().describe('the exact item key'),
        }),
        execute: async ({ environmentId, key }) => {
          const item = await this.workspace().getConfig(environmentId, key)
          if (!item) return { found: false as const }
          return {
            found: true as const,
            key: item.key,
            kind: item.kind,
            contentType: item.contentType,
            version: item.version,
            // Same bar as every other read surface: a secret's ciphertext never
            // becomes plaintext for the model, and the model has no reason to
            // see it — it can reason about presence and version alone.
            content: item.kind === 'secret' ? '' : item.content,
          }
        },
      }),
      recentActivity: tool({
        description:
          'List recent configuration changes in this workspace (what changed and by whom).',
        inputSchema: z.object({ limit: z.number().int().max(25).optional() }),
        execute: async ({ limit }) => {
          const events = await this.workspace().listActivity(limit ?? 25)
          return events.map((e) => ({
            action: e.action,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            // ISO 8601, not the raw `unixepoch()` seconds the DO stores. Handed
            // the bare integer the model either invents a relative time ("10
            // minutes ago" for a year-old event, varying run to run) or omits
            // the date entirely; with ISO it reports the real timestamp.
            at: new Date(e.createdAt * 1000).toISOString(),
          }))
        },
      }),
    }

    // Only offered where the model can actually produce them — see
    // `supportsStructuredTools`. Registering them everywhere meant a Workers AI
    // deployment advertised a capability that failed on every attempt.
    if (!supportsStructuredTools(this.env)) return readTools

    const proposalTools = {
      proposeChange: tool({
        description:
          'Propose creating or updating an item for the user to approve. Use this instead of claiming you changed something — you cannot write. Read the current value with getConfig first, and supply the complete new value, not a diff. Cannot propose secrets; tell the user to set those in the console.',
        inputSchema: configChangeToolInput,
        // Near-passthrough: the return value *is* the proposal, and its only
        // effect is to exist as a tool-call record the client can render an
        // Approve button on. Nothing is written here — see the contract note in
        // @edgevault/edge-protocol. `toConfigChangeProposal` only restores the
        // fields the model isn't asked to supply.
        execute: async (input) => {
          const proposal = toConfigChangeProposal(input)
          await emitAudit(
            this.env,
            aiProposalEvent({
              workspaceId: this.workspaceId,
              environmentId: input.environmentId,
              kind: input.itemKind,
              key: input.key,
              userId: this.userId,
            }),
          )
          return proposal
        },
      }),
      proposePromotion: tool({
        description:
          'Propose promoting one key from one environment to another for the user to approve. Same rule as proposeChange: this only suggests, it does not promote.',
        inputSchema: promotionToolInput,
        execute: async (input) => {
          const proposal = toPromotionProposal(input)
          await emitAudit(
            this.env,
            aiProposalEvent({
              workspaceId: this.workspaceId,
              environmentId: input.targetEnvironmentId,
              kind: 'config',
              key: input.key,
              userId: this.userId,
            }),
          )
          return proposal
        },
      }),
    }

    return { ...readTools, ...proposalTools }
  }

  /**
   * Streaming chat (Agents SDK). The model decides when to call the tools above;
   * messages are persisted by the SDK.
   */
  override async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0],
    options?: Parameters<AIChatAgent<Env>['onChatMessage']>[1],
  ): Promise<Response | undefined> {
    // Metered upstream work, so cap it per user. The HTTP /search route has had
    // this since it shipped; the socket had nothing, which made an authenticated
    // member an unmetered Workers AI proxy. Refuse in-band (a normal assistant
    // turn) rather than erroring the socket — a dropped connection reads as a
    // bug, and the client would retry into the same limit.
    // `/agents/*` permits a name with no `:userId` segment (a workspace-shared
    // thread). Falling back to the workspace keeps those in their own bucket —
    // keying them all as `ai:` would put every such thread in one global bucket,
    // where any workspace could rate-limit every other.
    const limitKey = this.userId ? `ai:${this.userId}` : `ai:ws:${this.workspaceId}`
    const allowed = await checkRateLimit(this.env.AI_USER_LIMITER, limitKey)
    if (!allowed) {
      await emitAudit(
        this.env,
        aiRateLimitedEvent({ workspaceId: this.workspaceId, userId: this.userId }),
      )
      return refusalResponse(RATE_LIMITED_MESSAGE)
    }

    // Model choice lives in ./providers.ts. On the Workers AI default,
    // `workers-ai-provider` is patched (patches/workers-ai-provider@3.2.0.patch):
    // a Workers AI chunk carries the same payload twice — once in the native
    // top-level fields, once in the OpenAI-shaped `choices[0].delta` — and the
    // stock provider has an unguarded emit branch for each:
    //   text       → every token streamed twice ("HelloHello!!")
    //   tool calls → args concatenated into invalid JSON, so every tool call
    //                dies as tool-input-error and the user sees nothing
    // The text case presents as a console bug because only the deltas double,
    // never the surrounding text-start/text-end. Both guarded by
    // test/assistant-stream.test.ts.
    const result = streamText({
      model: chatModel(this.env),
      // The last paragraph is load-bearing, not boilerplate. Without it
      // llama-4-scout answers tool-using turns with its own call syntax as the
      // final text — `recentActivity(limit=10)` — in 9 of 10 runs against live
      // Workers AI. The provider's parseLeakedToolCalls salvage does not catch
      // this: it JSON.parses the buffer, so it only recovers JSON-shaped leaks,
      // and it is gated on a forced toolChoice we deliberately don't set (that
      // would force a tool call on every turn, including "say hello"). Spelling
      // out that the tool has already run takes the leak rate to 0 of 10.
      // The middle paragraph tracks which tools were actually registered. Telling
      // a model to call a tool it hasn't been given is how you get it writing the
      // call out as prose.
      system: `You are EdgeVault's assistant for a single workspace. Use the searchConfigs tool to find items by meaning, getConfig to read one item's current value, and recentActivity for what changed and why. Cite items by key; be concise; never invent keys or values.\n\n${
        supportsStructuredTools(this.env)
          ? "You cannot change anything yourself. When the user wants a change, call proposeChange (or proposePromotion) — that shows them an approve button, and they apply it. Read the current value with getConfig first and propose the complete new value. Never say you have made, saved, or applied a change; say you've proposed it. You cannot propose secret values — tell the user to set those in the console."
          : 'You are read-only: you can find and explain things, but you cannot change anything and you have no tool that proposes changes. When the user wants something changed, say plainly that they need to make the change in the console, and tell them exactly which environment and key to open. Never claim you have made, saved, proposed, or queued a change.'
      }\n\nAfter a tool returns results, reply to the user in plain prose that answers their question using those results. Never write a tool call, function-call syntax, or raw JSON as your reply — the tool has already run and the user cannot see or execute it.`,
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
    // `streamText`'s onError above only sees stream-level failures. A tool call
    // whose arguments fail their schema never reaches it: the SDK turns that
    // into an errored tool part and masks the reason as "An error occurred."
    // That combination cost a staging debugging cycle — five identical failures
    // in the UI and a completely silent tail. Log the real cause here, and keep
    // returning a generic string to the client so schema internals and model
    // output don't leak into the browser.
    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error(
          'chat stream/tool error:',
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )
        return 'Something went wrong while answering. Please try again.'
      },
    })
  }
}
