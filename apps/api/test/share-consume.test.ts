import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { ShareDurableObject } from '../src/durable-objects/share'
import app from '../src/index'

// Reproduce the public consume path end-to-end through the api worker's HTTP
// surface (the layer the DO unit test doesn't cover). The console BFF hits this
// exact route with the shared INTERNAL_TOKEN.
function makeShare(id: string) {
  return env.SHARE.get(env.SHARE.idFromName(id)) as DurableObjectStub<ShareDurableObject>
}

async function consume(id: string, token: string = env.INTERNAL_TOKEN) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request(`https://api.test/internal/shares/${id}/consume`, {
      method: 'POST',
      headers: { 'x-internal-token': token },
    }),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('POST /internal/shares/:id/consume', () => {
  it('returns the ciphertext for a freshly created share', async () => {
    const id = 'abcdefghijklmnop1234' // 20 chars, url-safe — matches the id charset
    await makeShare(id).create({
      ciphertext: 'CT',
      iv: 'IV',
      expiresAt: Date.now() + 60_000,
      maxViews: 1,
      createdBy: 'u1',
    })

    const res = await consume(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ciphertext: 'CT', iv: 'IV', remainingViews: 0 })
  })
})
