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
