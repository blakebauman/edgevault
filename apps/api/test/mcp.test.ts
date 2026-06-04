import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { WorkspaceDurableObject } from '../src/durable-objects/workspace'
import { handleMcpMessage, type McpToolContext } from '../src/mcp/server'
import { edgevaultTools } from '../src/mcp/tools'

const ctx: McpToolContext = { env, workspaceId: 'mcp-ws', userId: 'mcp-user' }

// biome-ignore lint/suspicious/noExplicitAny: test reads into JSON-RPC result shapes
function call(message: Record<string, unknown>): Promise<{ status: number; body?: any }> {
  return handleMcpMessage(message, edgevaultTools, ctx)
}

function workspace() {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName('mcp-ws'),
  ) as DurableObjectStub<WorkspaceDurableObject>
}

describe('MCP server', () => {
  it('initialize returns protocol version + server info', async () => {
    const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.body.result.serverInfo.name).toBe('edgevault')
    expect(res.body.result.protocolVersion).toBeTruthy()
    expect(res.body.result.capabilities.tools).toBeTruthy()
  })

  it('tools/list advertises the EdgeVault tools with schemas', async () => {
    const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = res.body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'list_environments',
        'get_config',
        'set_config',
        'promote_config',
        'search_configs',
        'get_activity',
      ]),
    )
    const setTool = res.body.result.tools.find((t: { name: string }) => t.name === 'set_config')
    expect(setTool.inputSchema.required).toContain('content')
  })

  it('notifications receive no response (202)', async () => {
    const res = await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(res.body).toBeUndefined()
  })

  it('tools/call set_config then get_config round-trips via the DO', async () => {
    const e = await workspace().createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const setRes = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'set_config',
        arguments: { environmentId: e.id, key: 'f.x', content: '{"on":true}', kind: 'flag' },
      },
    })
    expect(setRes.body.result.isError).toBeFalsy()

    const getRes = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_config', arguments: { environmentId: e.id, key: 'f.x' } },
    })
    const item = JSON.parse(getRes.body.result.content[0].text)
    expect(item.key).toBe('f.x')
    expect(item.kind).toBe('flag')
    expect(item.content).toBe('{"on":true}')
  })

  it('redacts secret content through get_config', async () => {
    const e = await workspace().createEnvironment({ name: 'Prod', slug: 'prod', userId: 'u1' })
    await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'set_config',
        arguments: {
          environmentId: e.id,
          key: 'db.pw',
          content: 'hunter2',
          kind: 'secret',
          contentType: 'text',
        },
      },
    })
    const getRes = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_config', arguments: { environmentId: e.id, key: 'db.pw' } },
    })
    expect(getRes.body.result.content[0].text).not.toContain('hunter2')
  })

  it('returns an error for an unknown tool and unknown method', async () => {
    const unknownTool = await call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(unknownTool.body.error.code).toBe(-32602)

    const unknownMethod = await call({ jsonrpc: '2.0', id: 8, method: 'frobnicate' })
    expect(unknownMethod.body.error.code).toBe(-32601)
  })
})
