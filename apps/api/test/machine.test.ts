import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { hashToken } from '@edgevault/auth'
import { encryptSecret } from '@edgevault/crypto'
import { apiKeyCacheKey, type ResolvedConfig } from '@edgevault/edge-protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import type { VaultDurableObject } from '../src/durable-objects/vault'
import app from '../src/index'

/**
 * Machine export e2e: environment API key (KV) -> workspace DO (real items,
 * including an envelope-encrypted secret and a ${ref}) -> decrypted export.
 */

const WS = 'machine-ws'
const READ_KEY = 'evk_live_machine-read'
const SECRETS_KEY = 'evk_live_machine-secrets'

let envId = ''

function workspace() {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(WS)) as DurableObjectStub<VaultDurableObject>
}

async function call(path: string, apiKey?: string) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request(`https://api.test${path}`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    }),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

type ExportBody = {
  environmentId: string
  configs: Record<string, ResolvedConfig>
  secrets: Record<string, string>
  secretsIncluded: boolean
}

beforeAll(async () => {
  const ws = workspace()
  const environment = await ws.createEnvironment({ name: 'CI', slug: 'ci', userId: 'u1' })
  envId = environment.id

  await ws.setConfig({
    environmentId: envId,
    key: 'HOST',
    content: 'api.internal',
    contentType: 'text',
    userId: 'u1',
  })
  await ws.setConfig({
    environmentId: envId,
    key: 'URL',
    content: 'https://${HOST}/v1',
    contentType: 'text',
    userId: 'u1',
  })
  const envelope = await encryptSecret(env.MASTER_KEK, WS, 'hunter2')
  await ws.setConfig({
    environmentId: envId,
    key: 'DB_PASSWORD',
    kind: 'secret',
    content: JSON.stringify(envelope),
    isEncrypted: true,
    contentType: 'text',
    userId: 'u1',
  })

  await env.ENVIRONMENT_API_KEYS.put(
    apiKeyCacheKey(hashToken(READ_KEY)),
    JSON.stringify({ workspaceId: WS, environmentId: envId, scopes: ['read'] }),
  )
  await env.ENVIRONMENT_API_KEYS.put(
    apiKeyCacheKey(hashToken(SECRETS_KEY)),
    JSON.stringify({ workspaceId: WS, environmentId: envId, scopes: ['read', 'secrets:read'] }),
  )
})

describe('machine export', () => {
  it('rejects missing and unknown API keys', async () => {
    expect((await call('/machine/v1/export')).status).toBe(401)
    expect((await call('/machine/v1/export', 'evk_live_nope')).status).toBe(401)
  })

  it('exports resolved configs but omits secrets for a read-scope key', async () => {
    const res = await call('/machine/v1/export', READ_KEY)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ExportBody
    expect(body.secretsIncluded).toBe(false)
    expect(body.secrets).toEqual({})
    // ${HOST} is expanded — the CLI injects final values.
    expect(body.configs.URL?.content).toBe('https://api.internal/v1')
    expect(body.configs.HOST?.content).toBe('api.internal')
    expect(body.configs.DB_PASSWORD).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it('decrypts secrets for a secrets:read key', async () => {
    const res = await call('/machine/v1/export', SECRETS_KEY)
    const body = (await res.json()) as ExportBody
    expect(body.secretsIncluded).toBe(true)
    expect(body.secrets.DB_PASSWORD).toBe('hunter2')
    expect(body.configs.URL?.content).toBe('https://api.internal/v1')
  })
})
