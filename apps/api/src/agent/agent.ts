import { DurableObject } from 'cloudflare:workers'
import { redactCredentials } from '@edgevault/ai'
import { aiRunner, textModel } from '../ai'
import type { ActivityEntry } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'

/**
 * EdgeVault Agent — a per-workspace assistant that answers "what changed and
 * why" grounded in the workspace's activity log, with persistent chat history
 * in its own SQLite. It uses the configured text model when available and
 * degrades to a deterministic summary of recent activity otherwise, so it is
 * useful (and testable) with or without live Workers AI.
 *
 * This is the server-side agent; the console wraps it with a chat UI. A future
 * upgrade can adopt the Agents SDK for `useAgent` state-sync over WebSockets.
 */

export interface AskResult {
  answer: string
  source: 'ai' | 'fallback'
  groundedOnEvents: number
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

export class EdgeVaultAgent extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )`)
  }

  async ask(input: { workspaceId: string; question: string; userId?: string }): Promise<AskResult> {
    const workspace = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(input.workspaceId),
    ) as DurableObjectStub<VaultDurableObject>
    const events = await workspace.listActivity(25)

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
      const result = (await aiRunner(this.env).run(textModel(this.env), {
        messages: [
          {
            role: 'system',
            content:
              "You are EdgeVault's assistant. Answer questions about recent configuration changes using ONLY the provided activity log. Be concise and cite the relevant changes.",
          },
          { role: 'user', content: `Recent activity:\n${context}\n\nQuestion: ${input.question}` },
        ],
      })) as { response?: string }
      answer = (result.response ?? '').trim()
      if (!answer) throw new Error('empty response')
      source = 'ai'
    } catch {
      answer = fallbackAnswer(events, names)
      source = 'fallback'
    }

    this.sql.exec(
      `INSERT INTO chat_turns (id, question, answer, source, user_id) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.question,
      answer,
      source,
      input.userId ?? null,
    )

    return { answer, source, groundedOnEvents: events.length }
  }

  getHistory(limit = 50): ChatTurn[] {
    return this.sql
      .exec<ChatTurnRow>(
        `SELECT * FROM chat_turns ORDER BY created_at DESC, id DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        source: row.source,
        userId: row.user_id,
        createdAt: row.created_at,
      }))
  }
}
