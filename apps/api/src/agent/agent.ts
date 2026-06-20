import { AIChatAgent } from '@cloudflare/ai-chat'
import { redactCredentials, searchConfigs } from '@edgevault/ai'
import { convertToModelMessages, streamText, type ToolSet, tool } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import { aiRunner, embeddingModel, textModel, vectorize } from '../ai'
import type { ActivityEntry } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'

/**
 * EdgeVault Agent — a per-workspace assistant grounded in the workspace's
 * activity log and config content.
 *
 * Migration in progress (Phase A): the class now extends the Agents SDK's
 * `AIChatAgent`, which gives it `onChatMessage` (streaming chat over WebSocket
 * with model-chosen tools and SDK-managed message persistence). The legacy
 * `ask()` RPC + `chat_turns` SQLite path is kept intact so the console keeps
 * working unchanged until the client is migrated (Phase C). `ask()` retains the
 * deterministic no-AI fallback; the streaming path is wired for when Workers AI
 * is available. The agent instance name is `${workspaceId}` or
 * `${workspaceId}:${userId}` — the workspace id is its first segment.
 */

/** A config item the retrieval step surfaced for the question — the UI links it. */
export interface Citation {
  key: string
  environmentId: string
  kind: string
  score: number
}

export interface AskResult {
  answer: string
  source: 'ai' | 'fallback'
  groundedOnEvents: number
  /** Config items relevant to the question (semantic search); may be empty. */
  citations: Citation[]
}

export interface ChatTurn {
  id: string
  question: string
  answer: string
  source: string
  userId: string | null
  createdAt: number
}

type ChatTurnRow = {
  id: string
  question: string
  answer: string
  source: string
  user_id: string | null
  created_at: number
}

function describeEvent(event: ActivityEntry, names: Map<string, string>): string {
  const actor = event.userId ? (names.get(event.userId) ?? event.userId) : null
  const who = actor ? ` by ${actor}` : ''
  return `- ${event.action} ${event.resourceType} "${event.resourceId}"${who}`
}

function fallbackAnswer(events: ActivityEntry[], names: Map<string, string>): string {
  if (events.length === 0) return 'No recent activity has been recorded for this workspace yet.'
  const recent = events
    .slice(0, 6)
    .map((event) => describeEvent(event, names))
    .join('\n')
  return `Here are the most recent changes in this workspace:\n${recent}`
}

export class EdgeVaultAgent extends AIChatAgent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Legacy chat history for the RPC `ask()` path (the SDK manages its own
    // message store for the streaming path). `sql` is a base-class method now,
    // so raw queries go through ctx.storage.sql.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )`)
  }

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
   * messages are persisted by the SDK. Not yet wired to the console client
   * (Phase C); the deterministic no-AI fallback still lives on `ask()`.
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

  async ask(input: { workspaceId: string; question: string; userId?: string }): Promise<AskResult> {
    const workspace = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(input.workspaceId),
    ) as DurableObjectStub<VaultDurableObject>
    const events = await workspace.listActivity(25)

    // Retrieval-augment: pull the config items most relevant to the question so
    // the agent can answer "find …" and cite real keys, not just narrate
    // activity. Degrades to no citations when Vectorize/AI is unavailable (e.g.
    // local dev) or indexing is off — the search namespace is simply empty.
    let citations: Citation[] = []
    try {
      citations = await searchConfigs(
        {
          ai: aiRunner(this.env),
          vectorize: vectorize(this.env),
          embeddingModel: embeddingModel(this.env),
        },
        { workspaceId: input.workspaceId, query: input.question, topK: 5 },
      )
    } catch {
      // retrieval unavailable — answer from activity alone
    }

    // The model (and the fallback) speak about people, not UUIDs — resolve
    // actor ids to names before anything reaches a prompt. Best-effort: on
    // lookup failure the ids degrade through gracefully.
    let names = new Map<string, string>()
    const ids = [...new Set(events.map((e) => e.userId).filter((id): id is string => !!id))]
    if (ids.length > 0) {
      try {
        const { createDatabase } = await import('@edgevault/database')
        const conn = createDatabase(this.env.HYPERDRIVE.connectionString)
        try {
          const { getUserDisplayNames } = await import('../database/queries')
          names = await getUserDisplayNames(conn.database, ids)
        } finally {
          this.ctx.waitUntil(conn.close())
        }
      } catch {
        // names stay empty; raw ids are still meaningful to admins
      }
    }

    let answer = ''
    let source: 'ai' | 'fallback' = 'fallback'
    try {
      // Defense-in-depth: activity descriptions are names/keys, not values,
      // but anything credential-shaped is redacted before LLM inference.
      const context = redactCredentials(
        events.map((event) => describeEvent(event, names)).join('\n'),
      ).text
      const matchLines = citations.length
        ? citations.map((m) => `- ${m.kind} "${m.key}"`).join('\n')
        : '(no matching items)'
      const result = (await aiRunner(this.env).run(textModel(this.env), {
        messages: [
          {
            role: 'system',
            content:
              "You are EdgeVault's assistant for a single workspace. Answer using the recent activity log and the matching config items provided. When the user is looking for something, point them to the relevant items by key. Be concise; never invent keys or values.",
          },
          {
            role: 'user',
            content: `Matching config items:\n${matchLines}\n\nRecent activity:\n${context}\n\nQuestion: ${input.question}`,
          },
        ],
      })) as { response?: string }
      answer = (result.response ?? '').trim()
      if (!answer) throw new Error('empty response')
      source = 'ai'
    } catch {
      answer = fallbackAnswer(events, names)
      source = 'fallback'
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO chat_turns (id, question, answer, source, user_id) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.question,
      answer,
      source,
      input.userId ?? null,
    )

    return { answer, source, groundedOnEvents: events.length, citations }
  }

  /** Per-user by default (each caller sees only their own thread); omit userId
   * for the full workspace history. */
  getHistory(userId?: string, limit = 50): ChatTurn[] {
    const rows = userId
      ? this.ctx.storage.sql.exec<ChatTurnRow>(
          `SELECT * FROM chat_turns WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          userId,
          limit,
        )
      : this.ctx.storage.sql.exec<ChatTurnRow>(
          `SELECT * FROM chat_turns ORDER BY created_at DESC, id DESC LIMIT ?`,
          limit,
        )
    return rows.toArray().map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      source: row.source,
      userId: row.user_id,
      createdAt: row.created_at,
    }))
  }
}
