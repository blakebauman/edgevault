import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { WorkspaceDurableObject } from '../src/durable-objects/workspace'

function workspace(name: string) {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName(name),
  ) as DurableObjectStub<WorkspaceDurableObject>
}

describe('WorkspaceDurableObject', () => {
  it('creates environments and isolates workspaces', async () => {
    const ws = workspace('ws-a')
    const dev = await ws.createEnvironment({ name: 'Development', slug: 'dev', userId: 'u1' })
    expect(dev.slug).toBe('dev')
    expect(await ws.listEnvironments()).toHaveLength(1)

    // A different workspace id is a different DO instance — fully isolated.
    expect(await workspace('ws-b').listEnvironments()).toHaveLength(0)
  })

  it('versions config writes and records revisions + activity', async () => {
    const ws = workspace('ws-versions')
    const env1 = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })

    const v1 = await ws.setConfig({
      environmentId: env1.id,
      key: 'feature.timeout',
      content: '{"ms":1000}',
      userId: 'u1',
    })
    expect(v1.version).toBe(1)
    expect(v1.publishedRevisionId).toBeTruthy()

    const v2 = await ws.setConfig({
      environmentId: env1.id,
      key: 'feature.timeout',
      content: '{"ms":2000}',
      userId: 'u2',
    })
    expect(v2.version).toBe(2)

    const revisions = await ws.listRevisions(env1.id, 'feature.timeout')
    expect(revisions).toHaveLength(2)
    expect(revisions[0]?.version).toBe(2) // newest first
    expect(revisions[0]?.contentHash).toHaveLength(64)

    const activity = await ws.listActivity()
    expect(activity.some((a) => a.action === 'config.created')).toBe(true)
    expect(activity.some((a) => a.action === 'config.updated')).toBe(true)
  })

  it('reverts to a prior revision', async () => {
    const ws = workspace('ws-revert')
    const e = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const first = await ws.setConfig({
      environmentId: e.id,
      key: 'k',
      content: 'one',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: e.id,
      key: 'k',
      content: 'two',
      contentType: 'text',
      userId: 'u1',
    })

    const reverted = await ws.revertToRevision(first.publishedRevisionId as string, 'u1')
    expect(reverted?.content).toBe('one')
    expect(reverted?.version).toBe(3) // revert creates a new version
  })

  it('promotes a config from one environment to another', async () => {
    const ws = workspace('ws-promote')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const prod = await ws.createEnvironment({ name: 'Prod', slug: 'prod', userId: 'u1' })
    await ws.setConfig({ environmentId: dev.id, key: 'k', content: '{"on":true}', userId: 'u1' })

    const promotion = await ws.promote({
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: prod.id,
      key: 'k',
      userId: 'u1',
    })
    expect(promotion.status).toBe('completed')

    const promoted = await ws.getConfig(prod.id, 'k')
    expect(promoted?.content).toBe('{"on":true}')
  })

  it('split promotion applies the snapshotted revision, not the latest', async () => {
    const ws = workspace('ws-split-promote')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const prod = await ws.createEnvironment({ name: 'Prod', slug: 'prod', userId: 'u1' })
    await ws.setConfig({ environmentId: dev.id, key: 'k', content: '{"v":1}', userId: 'u1' })

    const pending = await ws.createPendingPromotion({
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: prod.id,
      key: 'k',
      userId: 'u1',
    })
    expect(pending.status).toBe('pending')

    // Source changes AFTER the snapshot — the approved promotion must ignore it.
    await ws.setConfig({ environmentId: dev.id, key: 'k', content: '{"v":2}', userId: 'u1' })

    const target = await ws.applyPromotion(pending.id, 'u2')
    expect(target.content).toBe('{"v":1}')
    expect((await ws.getPromotion(pending.id))?.status).toBe('completed')
  })

  it('compares environments key-by-key without decrypting secrets', async () => {
    const ws = workspace('ws-compare')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const prod = await ws.createEnvironment({ name: 'Prod', slug: 'prod', userId: 'u1' })

    // equal in both
    await ws.setConfig({ environmentId: dev.id, key: 'same', content: '{"a":1}', userId: 'u1' })
    await ws.setConfig({ environmentId: prod.id, key: 'same', content: '{"a":1}', userId: 'u1' })
    // drifted JSON value
    await ws.setConfig({ environmentId: dev.id, key: 'drift', content: '{"a":2}', userId: 'u1' })
    await ws.setConfig({ environmentId: prod.id, key: 'drift', content: '{"a":1}', userId: 'u1' })
    // only in source / only in target
    await ws.setConfig({ environmentId: dev.id, key: 'new', content: '"x"', userId: 'u1' })
    await ws.setConfig({ environmentId: prod.id, key: 'old', content: '"y"', userId: 'u1' })
    // secrets: different ciphertext even for identical plaintext — must not compare
    await ws.setConfig({
      environmentId: dev.id,
      key: 'db.password',
      kind: 'secret',
      content: 'ciphertext-a',
      isEncrypted: true,
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'db.password',
      kind: 'secret',
      content: 'ciphertext-b',
      isEncrypted: true,
      userId: 'u1',
    })

    const comparison = await ws.compareEnvironments(dev.id, prod.id)
    expect(comparison.summary).toEqual({
      equal: 1,
      drifted: 1,
      onlyInSource: 1,
      onlyInTarget: 1,
      notComparable: 1,
    })

    const byKey = new Map(comparison.entries.map((e) => [e.key, e]))
    expect(byKey.get('same')?.status).toBe('equal')
    expect(byKey.get('new')?.status).toBe('only-in-source')
    expect(byKey.get('old')?.status).toBe('only-in-target')

    const drift = byKey.get('drift')
    expect(drift?.status).toBe('drifted')
    expect(drift?.diffSummary).toBe('1 modified')
    expect(drift?.diff).toEqual([{ type: 'modified', path: 'a', oldValue: 2, newValue: 1 }])

    // Secrets report presence only — no content, no diff.
    const secret = byKey.get('db.password')
    expect(secret?.status).toBe('not-comparable')
    expect(secret?.diff).toBeUndefined()
    expect(JSON.stringify(comparison)).not.toContain('ciphertext')
  })

  it('compareEnvironments rejects unknown environments', async () => {
    const ws = workspace('ws-compare-unknown')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    // Call the instance directly — a rejection over the RPC stub also surfaces
    // as an unhandled error inside the DO under vitest-pool-workers.
    await runInDurableObject(ws, async (instance) => {
      await expect(instance.compareEnvironments(dev.id, 'nope')).rejects.toThrow(
        'Environment not found',
      )
    })
  })

  it('can inspect internal SQLite state directly', async () => {
    const ws = workspace('ws-internal')
    await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    await runInDurableObject(ws, (_instance, state) => {
      const count = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM environments')
        .one()
      expect(count.n).toBe(1)
    })
  })
})
