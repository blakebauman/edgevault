import { hashToken } from '@edgevault/auth'
import { type ApiKeyRecord, apiKeyCacheKey, type ResolvedConfig } from '@edgevault/edge-protocol'
import { Hono } from 'hono'
import { emitAudit } from '../audit'
import type { VaultDurableObject } from '../durable-objects/vault'
import { rateLimitByIp } from '../rate-limit'
import { revealSecret } from '../secrets'

/**
 * Machine surface: authenticated by environment-scoped API keys (same keys and
 * KV lookup the delivery worker uses), NOT user JWTs. The delivery plane serves
 * configs/flags but can never decrypt secrets — this endpoint can, which is why
 * secrets require the opt-in `secrets:read` key scope. Powers `edgevault run`.
 */

type MachineEnv = { Bindings: Env; Variables: { apiKey: ApiKeyRecord } }

export const machineRoutes = new Hono<MachineEnv>()
  // Cap unauthenticated key-guessing before the hash + KV lookup even runs.
  .use(
    '*',
    rateLimitByIp((env) => env.MACHINE_IP_LIMITER, 'machine'),
  )
  .use('*', async (c, next) => {
    const header = c.req.header('authorization')
    const presented = header?.toLowerCase().startsWith('bearer ')
      ? header.slice(7)
      : c.req.header('x-api-key')
    if (!presented) return c.json({ error: 'unauthorized' }, 401)
    const record = await c.env.ENVIRONMENT_API_KEYS.get<ApiKeyRecord>(
      apiKeyCacheKey(hashToken(presented)),
      'json',
    )
    if (!record) return c.json({ error: 'invalid_api_key' }, 401)
    c.set('apiKey', record)
    await next()
  })
  .get('/v1/export', async (c) => {
    const { workspaceId, environmentId, scopes } = c.var.apiKey
    const includeSecrets = scopes.includes('secrets:read')
    const stub = c.env.WORKSPACE.get(
      c.env.WORKSPACE.idFromName(workspaceId),
    ) as DurableObjectStub<VaultDurableObject>
    const targets = await stub.listResolvedConfigs(environmentId)

    const configs: Record<string, ResolvedConfig> = {}
    const secrets: Record<string, string> = {}
    const secretKeys: string[] = []
    for (const { item, resolvedContent } of targets) {
      if (item.kind === 'secret') {
        if (!includeSecrets) continue
        const value = await revealSecret(c.env, workspaceId, item)
        if (value !== null) {
          secrets[item.key] = value
          secretKeys.push(item.key)
        }
      } else {
        configs[item.key] = {
          content: resolvedContent,
          contentType: item.contentType,
          kind: item.kind,
          version: item.version,
        }
      }
    }

    // Exports that decrypt secrets always leave an audit trail — including
    // WHICH keys were decrypted (names only, never values), capped to keep the
    // queue message small.
    if (secretKeys.length > 0) {
      c.executionCtx.waitUntil(
        emitAudit(c.env, {
          workspaceId,
          environmentId,
          action: 'environment.exported',
          resourceType: 'environment',
          userId: 'machine',
          count: secretKeys.length,
          detail: {
            keys: secretKeys.slice(0, 100).join(','),
            ...(secretKeys.length > 100 ? { truncated: 'true' } : {}),
          },
        }),
      )
    }

    return c.json({ environmentId, configs, secrets, secretsIncluded: includeSecrets })
  })
