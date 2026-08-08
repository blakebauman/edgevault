import { DurableObject } from 'cloudflare:workers'
import { searchConfigs } from '@edgevault/ai'
import type { AssistantServerMessage, AssistantSource } from '@edgevault/realtime'
import { stepCountIs, streamText, type ToolSet, tool } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import { aiRunner, embeddingModel, textModel, vectorize } from '../ai'
import type { VaultDurableObject } from '../durable-objects/vault'

/** Digests kept per workspace. Old rows are pruned past this. */
const MAX_DIGESTS = 50
/** How much of an answer is worth keeping in a digest. */
const DIGEST_CHARS = 400

/**
 * EdgeVault Agent — a per-workspace assistant grounded in the workspace's
 * activity log and config content.
 *
 * A plain hibernatable-WebSocket Durable Object speaking our own protocol
 * (`@edgevault/realtime` → assistant.ts), mirroring VaultDurableObject. It
 * previously extended `AIChatAgent` from `@cloudflare/ai-chat` over the
 * `agents` SDK; that stack coupled the console and this DO to a third-party
 * wire format and a third-party storage format, so a single dependency bump
 * could break the assistant with every build check still green, and a
 * downgrade left DOs holding state they could no longer read.
 *
 * `ai`'s streamText and tool calling are kept — they were never the problem
 * and are doing real work.
 *
 * The instance name is `<workspaceId>:<userId>:<generation>`; the workspace id
 * is its first segment.
 */
export class EdgeVaultAgent extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    // Summaries only, by design: what was asked and a truncated answer, not a
    // growing transcript. Raw turns live in the open connection and are gone
    // when it closes.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS assistant_digests (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
  }

  /** The workspace this agent instance serves (first name segment). */
  private get workspaceId(): string {
    return (this.ctx.id.name ?? '').split(':')[0] ?? ''
  }

  /** Recent question/answer digests, newest first. */
  listDigests(limit = 20): Array<{ question: string; answer: string; at: number }> {
    const rows = this.sql
      .exec(
        'SELECT question, answer, created_at FROM assistant_digests ORDER BY created_at DESC LIMIT ?',
        Math.min(limit, MAX_DIGESTS),
      )
      .toArray()
    return rows.map((r) => ({
      question: String(r.question),
      answer: String(r.answer),
      at: Number(r.created_at),
    }))
  }

  private saveDigest(question: string, answer: string): void {
    this.sql.exec(
      'INSERT INTO assistant_digests (id, question, answer, created_at) VALUES (?, ?, ?, ?)',
      crypto.randomUUID(),
      question.slice(0, DIGEST_CHARS),
      answer.slice(0, DIGEST_CHARS),
      Date.now(),
    )
    this.sql.exec(
      `DELETE FROM assistant_digests WHERE id NOT IN (
         SELECT id FROM assistant_digests ORDER BY created_at DESC LIMIT ?
       )`,
      MAX_DIGESTS,
    )
  }

  /** Tools the model can call: semantic config search + recent activity. */
  private chatTools(collect: (sources: AssistantSource[]) => void) {
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
            const mapped = hits.map((h) => ({
              key: h.key,
              kind: h.kind,
              environmentId: h.environmentId,
              score: h.score,
            }))
            // Surfaced to the client as `sources` so the UI can link them —
            // previously inferred from tool-call message parts.
            collect(mapped.map(({ key, kind, environmentId }) => ({ key, kind, environmentId })))
            return mapped
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
   * Upgrade to a hibernatable WebSocket. Auth and workspace membership are
   * already enforced by the api worker before the upgrade reaches us.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: { type?: string; turn?: string; text?: string }
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }

    if (parsed.type === 'ping') {
      this.send(ws, { type: 'pong', at: Date.now() })
      return
    }
    if (parsed.type !== 'ask') return
    const turn = parsed.turn
    const question = (parsed.text ?? '').trim()
    if (!turn || !question) return

    await this.runTurn(ws, turn, question)
  }

  override webSocketClose(ws: WebSocket): void {
    ws.close()
  }

  override webSocketError(ws: WebSocket): void {
    ws.close()
  }

  /**
   * One turn: stream the model's answer to this socket, then keep a digest.
   *
   * Deltas go only to the asking socket. The old stack broadcast turns to every
   * connection, which is part of why text arrived twice.
   */
  private async runTurn(ws: WebSocket, turn: string, question: string): Promise<void> {
    let answer = ''
    let sent = false
    try {
      const workersai = createWorkersAI({ binding: this.env.AI })
      const result = streamText({
        model: workersai(textModel(this.env) as Parameters<typeof workersai>[0]),
        system:
          "You are EdgeVault's assistant for a single workspace. Use the searchConfigs tool to find items by meaning and the recentActivity tool for what changed and why. Cite items by key; be concise; never invent keys or values.",
        prompt: question,
        tools: this.chatTools((sources) => {
          if (sources.length) this.send(ws, { type: 'sources', turn, sources })
        }) as ToolSet,
        // Without this the model stops after the tool CALL and never writes an
        // answer from the results — the user sees sources and no prose.
        stopWhen: stepCountIs(5),
      })

      for await (const chunk of result.textStream) {
        if (!chunk) continue
        answer += chunk
        sent = true
        this.send(ws, { type: 'delta', turn, text: chunk })
      }

      if (!sent) {
        this.send(ws, { type: 'error', turn, message: 'The assistant returned no answer.' })
        return
      }
      this.send(ws, { type: 'done', turn })
      this.saveDigest(question, answer)
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error('assistant turn failed:', detail)
      // Vendor-masked: the model/provider error text is not for the browser.
      this.send(ws, { type: 'error', turn, message: 'The assistant could not answer just now.' })
    }
  }

  private send(ws: WebSocket, message: AssistantServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // socket went away mid-turn; nothing to do
    }
  }
}
