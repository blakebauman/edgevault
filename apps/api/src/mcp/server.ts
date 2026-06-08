import type { z } from 'zod'

/**
 * Minimal, spec-compliant-for-tools MCP server over Streamable HTTP: handles
 * `initialize`, `tools/list`, `tools/call`, `ping`, and notifications as
 * JSON-RPC 2.0. This covers programmatic tool use; full protocol features
 * (resources/prompts/sampling, SSE streaming, OAuth) are a later upgrade to the
 * official SDK + @cloudflare/workers-oauth-provider.
 */

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'edgevault', version: '0.0.0' }

export interface McpToolContext {
  env: Env
  workspaceId: string
  userId: string
  /** Caller's org role (owner | admin | member), set by requireWorkspaceMember. */
  role: string | null
  /**
   * Whether the org requires a fresh step-up (passkey/TOTP) before a reveal.
   * Resolved once at the HTTP boundary (where the DB handle lives). When true,
   * reveal_secret refuses — an agent can't perform a second-factor ceremony, so
   * the human must reveal in the console.
   */
  requireStepUp?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  parse: (args: unknown) => { ok: true; value: unknown } | { ok: false; error: string }
  handler: (args: unknown, ctx: McpToolContext) => Promise<unknown>
}

export function defineTool<S extends z.ZodTypeAny>(def: {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: S
  handler: (args: z.infer<S>, ctx: McpToolContext) => Promise<unknown>
}): McpTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    parse: (args) => {
      const result = def.schema.safeParse(args ?? {})
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: result.error.message }
    },
    handler: def.handler as McpTool['handler'],
  }
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { name?: string; arguments?: unknown }
}

export interface McpResult {
  status: number
  body?: unknown
}

export async function handleMcpMessage(
  message: JsonRpcMessage,
  tools: McpTool[],
  ctx: McpToolContext,
): Promise<McpResult> {
  const id = message.id ?? null
  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } })
  const err = (code: number, msg: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message: msg } },
  })

  switch (message.method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === message.params?.name)
      if (!tool) return err(-32602, `Unknown tool: ${message.params?.name}`)
      const parsed = tool.parse(message.params?.arguments)
      if (!parsed.ok) {
        return ok({
          content: [{ type: 'text', text: `Invalid arguments: ${parsed.error}` }],
          isError: true,
        })
      }
      try {
        const result = await tool.handler(parsed.value, ctx)
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return ok({ content: [{ type: 'text', text }] })
      } catch (error) {
        return ok({
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : 'tool failed'}`,
            },
          ],
          isError: true,
        })
      }
    }
    default:
      // Notifications (no id, no response expected).
      if (message.method?.startsWith('notifications/')) return { status: 202 }
      return err(-32601, `Method not found: ${message.method}`)
  }
}
