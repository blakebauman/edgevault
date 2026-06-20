import { env } from 'cloudflare:test'
import { configCacheKey, type ResolvedConfig } from '@edgevault/edge-protocol'
import { describe, expect, it } from 'vitest'
import type { ConfigItem } from '../src/durable-objects/types'
import { writeThrough } from '../src/edge-cache'

function item(overrides: Partial<ConfigItem>): ConfigItem {
  return {
    id: 'i1',
    environmentId: 'env1',
    key: 'k',
    kind: 'config',
    content: 'v',
    contentType: 'json',
    isEncrypted: false,
    version: 1,
    publishedRevisionId: 'r1',
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'u1',
    updatedBy: 'u1',
    ...overrides,
  }
}

describe('edge-cache write-through', () => {
  it('publishes a content item to KV like config/flag', async () => {
    const it1 = item({ key: 'doc.home', kind: 'content', contentType: 'text' })
    await writeThrough(env, 'ws1', it1, '<main>hi</main>')

    const raw = await env.CONFIGS_CACHE.get<ResolvedConfig>(
      configCacheKey('ws1', 'env1', 'doc.home'),
      'json',
    )
    expect(raw).toEqual({
      content: '<main>hi</main>',
      contentType: 'text',
      kind: 'content',
      version: 1,
    })
  })

  it('never publishes a secret to KV', async () => {
    const it1 = item({ key: 'db.password', kind: 'secret' })
    await writeThrough(env, 'ws1', it1, 'ciphertext')

    const raw = await env.CONFIGS_CACHE.get(configCacheKey('ws1', 'env1', 'db.password'))
    expect(raw).toBeNull()
  })
})
