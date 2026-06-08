import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { VaultDurableObject } from '../src/durable-objects/vault'
import { handleMcpMessage, type McpToolContext } from '../src/mcp/server'
import { edgevaultTools } from '../src/mcp/tools'

// Admin context: reveal_secret carries the same owner/admin bar as HTTP reveal.
const ctx: McpToolContext = { env, workspaceId: 'mcp-ws', userId: 'mcp-user', role: 'admin' }

// biome-ignore lint/suspicious/noExplicitAny: test reads into JSON-RPC result shapes
function call(message: Record<string, unknown>): Promise<{ status: number; body?: any }> {
  return handleMcpMessage(message, edgevaultTools, ctx)
}

function workspace() {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName('mcp-ws'),
  ) as DurableObjectStub<VaultDurableObject>
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
        'compare_environments',
        'search_configs',
        'get_activity',
      ]),
    )
    const setTool = res.body.result.tools.find((t: { name: string }) => t.name === 'set_config')
    expect(setTool.inputSchema.required).toContain('content')
  })

  it('notifications receive no response (202)', async () => {
    const res = await call({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(res.status).toBe(202)
    expect(res.body).toBeUndefined()
  })

  it('tools/call set_config then get_config round-trips via the DO', async () => {
    const e = await workspace().createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    const setRes = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'set_config',
        arguments: {
          environmentId: e.id,
          key: 'f.x',
          content: '{"on":true}',
          kind: 'flag',
        },
      },
    })
    expect(setRes.body.result.isError).toBeFalsy()

    const getRes = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'get_config',
        arguments: { environmentId: e.id, key: 'f.x' },
      },
    })
    const item = JSON.parse(getRes.body.result.content[0].text)
    expect(item.key).toBe('f.x')
    expect(item.kind).toBe('flag')
    expect(item.content).toBe('{"on":true}')
  })

  it('redacts secret content through get_config', async () => {
    const e = await workspace().createEnvironment({
      name: 'Prod',
      slug: 'prod',
      userId: 'u1',
    })
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
      params: {
        name: 'get_config',
        arguments: { environmentId: e.id, key: 'db.pw' },
      },
    })
    expect(getRes.body.result.content[0].text).not.toContain('hunter2')

    // The DO stores an envelope, not the plaintext.
    const stored = await workspace().getConfig(e.id, 'db.pw')
    expect(stored?.isEncrypted).toBe(true)
    expect(stored?.content).not.toContain('hunter2')
    expect(JSON.parse(stored?.content ?? '{}').v).toBe(1)

    // reveal_secret decrypts it back (admin context).
    const revealRes = await call({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'reveal_secret',
        arguments: { environmentId: e.id, key: 'db.pw' },
      },
    })
    expect(JSON.parse(revealRes.body.result.content[0].text).content).toBe('hunter2')
  })

  it('reveal_secret is forbidden for non-admin members', async () => {
    const e = await workspace().createEnvironment({
      name: 'Sec',
      slug: 'sec',
      userId: 'u1',
    })
    await call({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'set_config',
        arguments: { environmentId: e.id, key: 'api.token', content: 's3cret', kind: 'secret' },
      },
    })
    const memberCtx: McpToolContext = { ...ctx, role: 'member' }
    const res = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'reveal_secret', arguments: { environmentId: e.id, key: 'api.token' } },
      },
      edgevaultTools,
      memberCtx,
    )
    // biome-ignore lint/suspicious/noExplicitAny: test reads into JSON-RPC result shapes
    const text = (res.body as any).result.content[0].text
    expect(JSON.parse(text).error).toBe('forbidden')
    expect(text).not.toContain('s3cret')
  })

  it('reveal_secret refuses with reauth_required when the org requires step-up', async () => {
    const e = await workspace().createEnvironment({ name: 'Step', slug: 'step', userId: 'u1' })
    await call({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'set_config',
        arguments: { environmentId: e.id, key: 'api.token', content: 's3cret', kind: 'secret' },
      },
    })
    // Admin, but the org policy requires a fresh second factor — which an agent
    // can't provide, so reveal is refused (not bypassed) and no plaintext leaks.
    const stepUpCtx: McpToolContext = { ...ctx, requireStepUp: true }
    const res = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'reveal_secret', arguments: { environmentId: e.id, key: 'api.token' } },
      },
      edgevaultTools,
      stepUpCtx,
    )
    // biome-ignore lint/suspicious/noExplicitAny: test reads into JSON-RPC result shapes
    const text = (res.body as any).result.content[0].text
    expect(JSON.parse(text).error).toBe('reauth_required')
    expect(text).not.toContain('s3cret')
  })

  it('reveal_secret and set_config leave a cold audit trail', async () => {
    const e = await workspace().createEnvironment({
      name: 'Aud',
      slug: 'aud',
      userId: 'u1',
    })
    const send = vi.fn(async () => {})
    const spyCtx: McpToolContext = {
      ...ctx,
      env: { ...env, AUDIT_QUEUE: { send } } as unknown as Env,
    }
    await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'set_config',
          arguments: { environmentId: e.id, key: 'aud.secret', content: 'x', kind: 'secret' },
        },
      },
      edgevaultTools,
      spyCtx,
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'config.created', key: 'aud.secret', userId: 'mcp-user' }),
    )

    send.mockClear()
    await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: 'reveal_secret', arguments: { environmentId: e.id, key: 'aud.secret' } },
      },
      edgevaultTools,
      spyCtx,
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'secret.revealed', key: 'aud.secret', userId: 'mcp-user' }),
    )
  })

  it('set_config rejects keys unsafe for cache keys and references', async () => {
    const e = await workspace().createEnvironment({
      name: 'Keys',
      slug: 'keys',
      userId: 'u1',
    })
    for (const key of ['db:pw', 'bad key!', 'a/b', '${oops}']) {
      const res = await call({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: { name: 'set_config', arguments: { environmentId: e.id, key, content: 'v' } },
      })
      expect(res.body.result.isError).toBe(true)
      expect(res.body.result.content[0].text).toContain('Invalid arguments')
    }
  })

  it('get_config reports resolved content for items with ${...} references', async () => {
    const ws = workspace()
    const e = await ws.createEnvironment({
      name: 'Refs',
      slug: 'refs',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: e.id,
      key: 'HOST',
      content: 'api.internal',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: e.id,
      key: 'URL',
      content: 'https://${HOST}/v1',
      contentType: 'text',
      userId: 'u1',
    })
    const res = await call({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'get_config',
        arguments: { environmentId: e.id, key: 'URL' },
      },
    })
    const item = JSON.parse(res.body.result.content[0].text)
    expect(item.content).toBe('https://${HOST}/v1')
    expect(item.resolvedContent).toBe('https://api.internal/v1')
  })

  it('compare_environments reports drift between two environments', async () => {
    const ws = workspace()
    const a = await ws.createEnvironment({
      name: 'Cmp A',
      slug: 'cmp-a',
      userId: 'u1',
    })
    const b = await ws.createEnvironment({
      name: 'Cmp B',
      slug: 'cmp-b',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: a.id,
      key: 'cmp.k',
      content: '{"v":1}',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: b.id,
      key: 'cmp.k',
      content: '{"v":2}',
      userId: 'u1',
    })

    const res = await call({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'compare_environments',
        arguments: { sourceEnvironmentId: a.id, targetEnvironmentId: b.id },
      },
    })
    const comparison = JSON.parse(res.body.result.content[0].text)
    expect(comparison.summary.drifted).toBe(1)
    expect(comparison.entries[0].key).toBe('cmp.k')
    expect(comparison.entries[0].diffSummary).toBe('1 modified')
  })

  it('returns an error for an unknown tool and unknown method', async () => {
    const unknownTool = await call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(unknownTool.body.error.code).toBe(-32602)

    const unknownMethod = await call({
      jsonrpc: '2.0',
      id: 8,
      method: 'frobnicate',
    })
    expect(unknownMethod.body.error.code).toBe(-32601)
  })
})
