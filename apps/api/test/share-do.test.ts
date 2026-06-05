import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { ShareDurableObject } from '../src/durable-objects/share'

function share(name: string) {
  return env.SHARE.get(env.SHARE.idFromName(name)) as DurableObjectStub<ShareDurableObject>
}

const input = {
  ciphertext: 'b64-ciphertext',
  iv: 'b64-iv',
  expiresAt: Date.now() + 60_000,
  maxViews: 1,
  createdBy: 'u1',
}

describe('ShareDurableObject', () => {
  it('burns after the last view (maxViews=1)', async () => {
    const s = share('s-burn')
    await s.create(input)

    const first = await s.consume()
    expect(first).toEqual({
      ok: true,
      ciphertext: 'b64-ciphertext',
      iv: 'b64-iv',
      remainingViews: 0,
    })
    expect(await s.consume()).toEqual({ ok: false })
  })

  it('decrements views atomically until exhausted (maxViews=3)', async () => {
    const s = share('s-views')
    await s.create({ ...input, maxViews: 3 })
    expect((await s.consume()).ok).toBe(true)
    expect((await s.consume()).ok).toBe(true)
    const last = await s.consume()
    expect(last.ok).toBe(true)
    expect(last.ok && last.remainingViews).toBe(0)
    expect(await s.consume()).toEqual({ ok: false })
  })

  it('treats expired shares as gone and wipes them', async () => {
    const s = share('s-expired')
    await s.create({ ...input, expiresAt: Date.now() - 1 })
    expect(await s.consume()).toEqual({ ok: false })
    await runInDurableObject(s, async (_instance, state) => {
      expect(await state.storage.get('share')).toBeUndefined()
    })
  })

  it('refuses to overwrite an existing share (ids are single-use)', async () => {
    const s = share('s-dupe')
    await s.create(input)
    await runInDurableObject(s, async (instance) => {
      await expect(instance.create(input)).rejects.toThrow('already exists')
    })
  })

  it('alarm wipes expired ciphertext at rest', async () => {
    const s = share('s-alarm')
    await s.create(input)
    const ran = await runDurableObjectAlarm(s)
    expect(ran).toBe(true)
    await runInDurableObject(s, async (_instance, state) => {
      expect(await state.storage.get('share')).toBeUndefined()
    })
    expect(await s.consume()).toEqual({ ok: false })
  })
})
