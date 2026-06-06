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
    const dev = await ws.createEnvironment({
      name: 'Development',
      slug: 'dev',
      userId: 'u1',
    })
    expect(dev.slug).toBe('dev')
    expect(await ws.listEnvironments()).toHaveLength(1)

    // A different workspace id is a different DO instance — fully isolated.
    expect(await workspace('ws-b').listEnvironments()).toHaveLength(0)
  })

  it('versions config writes and records revisions + activity', async () => {
    const ws = workspace('ws-versions')
    const env1 = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })

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
    const e = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
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
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    const prod = await ws.createEnvironment({
      name: 'Prod',
      slug: 'prod',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'k',
      content: '{"on":true}',
      userId: 'u1',
    })

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
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    const prod = await ws.createEnvironment({
      name: 'Prod',
      slug: 'prod',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'k',
      content: '{"v":1}',
      userId: 'u1',
    })

    const pending = await ws.createPendingPromotion({
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: prod.id,
      key: 'k',
      userId: 'u1',
    })
    expect(pending.status).toBe('pending')

    // Source changes AFTER the snapshot — the approved promotion must ignore it.
    await ws.setConfig({
      environmentId: dev.id,
      key: 'k',
      content: '{"v":2}',
      userId: 'u1',
    })

    const target = await ws.applyPromotion(pending.id, 'u2')
    expect(target.content).toBe('{"v":1}')
    expect((await ws.getPromotion(pending.id))?.status).toBe('completed')
  })

  it('compares environments key-by-key without decrypting secrets', async () => {
    const ws = workspace('ws-compare')
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    const prod = await ws.createEnvironment({
      name: 'Prod',
      slug: 'prod',
      userId: 'u1',
    })

    // equal in both
    await ws.setConfig({
      environmentId: dev.id,
      key: 'same',
      content: '{"a":1}',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'same',
      content: '{"a":1}',
      userId: 'u1',
    })
    // drifted JSON value
    await ws.setConfig({
      environmentId: dev.id,
      key: 'drift',
      content: '{"a":2}',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'drift',
      content: '{"a":1}',
      userId: 'u1',
    })
    // only in source / only in target
    await ws.setConfig({
      environmentId: dev.id,
      key: 'new',
      content: '"x"',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'old',
      content: '"y"',
      userId: 'u1',
    })
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
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    // Call the instance directly — a rejection over the RPC stub also surfaces
    // as an unhandled error inside the DO under vitest-pool-workers.
    await runInDurableObject(ws, async (instance) => {
      await expect(instance.compareEnvironments(dev.id, 'nope')).rejects.toThrow(
        'Environment not found',
      )
    })
  })

  it('resolves ${KEY} references for publish targets, transitively', async () => {
    const ws = workspace('ws-refs')
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'HOST',
      content: 'api.internal',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'URL',
      content: 'https://${HOST}/v1',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'CLIENT_CONF',
      content: 'endpoint=${URL}',
      contentType: 'text',
      userId: 'u1',
    })

    // Changing HOST must republish HOST, URL (direct), and CLIENT_CONF (transitive).
    await ws.setConfig({
      environmentId: dev.id,
      key: 'HOST',
      content: 'api2.internal',
      contentType: 'text',
      userId: 'u1',
    })
    const { targets, truncated } = await ws.collectPublishTargets(dev.id, 'HOST')
    expect(truncated).toBe(false)
    const byKey = new Map(targets.map((t) => [t.item.key, t.resolvedContent]))
    expect(byKey.get('HOST')).toBe('api2.internal')
    expect(byKey.get('URL')).toBe('https://api2.internal/v1')
    expect(byKey.get('CLIENT_CONF')).toBe('endpoint=https://api2.internal/v1')
    // Raw content in the DO keeps the placeholders.
    expect((await ws.getConfig(dev.id, 'URL'))?.content).toBe('https://${HOST}/v1')
  })

  it('resolves cross-environment refs in the target environment', async () => {
    const ws = workspace('ws-refs-xenv')
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    const prod = await ws.createEnvironment({
      name: 'Prod',
      slug: 'prod',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'HOST',
      content: 'api.example.com',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: prod.id,
      key: 'URL',
      content: 'https://${HOST}/v1',
      contentType: 'text',
      userId: 'u1',
    })
    // dev item referencing prod/URL: nested ${HOST} must resolve to PROD's host.
    await ws.setConfig({
      environmentId: dev.id,
      key: 'MIRROR',
      content: '${prod/URL}',
      contentType: 'text',
      userId: 'u1',
    })
    const { targets } = await ws.collectPublishTargets(dev.id, 'MIRROR')
    expect(targets[0]?.resolvedContent).toBe('https://api.example.com/v1')
  })

  it('rejects unknown refs, secret refs, cycles, and guarded deletes', async () => {
    const ws = workspace('ws-refs-invalid')
    const dev = await ws.createEnvironment({
      name: 'Dev',
      slug: 'dev',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'SECRET_K',
      kind: 'secret',
      content: 'ciphertext',
      isEncrypted: true,
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'BASE',
      content: 'b',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'REF',
      content: '${BASE}',
      contentType: 'text',
      userId: 'u1',
    })

    await runInDurableObject(ws, async (instance) => {
      const write = (key: string, content: string) =>
        instance.setConfig({
          environmentId: dev.id,
          key,
          content,
          contentType: 'text',
          userId: 'u1',
        })

      await expect(write('X', '${NOPE}')).rejects.toThrow('unknown reference')
      await expect(write('X', '${ghost/BASE}')).rejects.toThrow('unknown reference')
      await expect(write('X', '${SECRET_K}')).rejects.toThrow('secrets cannot be referenced')
      // A new item referencing itself fails as unknown (it doesn't exist yet)…
      await expect(write('X', '${X}')).rejects.toThrow('unknown reference')
      // …an EXISTING item updated to reference itself is a cycle, as is the
      // indirect cycle BASE ← REF, writing BASE = ${REF}.
      await write('CYC', 'plain')
      await expect(write('CYC', '${CYC}')).rejects.toThrow('circular')
      await expect(write('BASE', '${REF}')).rejects.toThrow('circular')

      // BASE is referenced by REF: it can't be deleted or become a secret.
      await expect(instance.deleteConfig(dev.id, 'BASE', 'u1')).rejects.toThrow('referenced by')
      await expect(
        instance.setConfig({
          environmentId: dev.id,
          key: 'BASE',
          kind: 'secret',
          content: 'c',
          contentType: 'text',
          userId: 'u1',
        }),
      ).rejects.toThrow('cannot be a secret')

      // Removing the reference frees BASE for deletion.
      await write('REF', 'no refs anymore')
      await expect(instance.deleteConfig(dev.id, 'BASE', 'u1')).resolves.toBe(true)
    })
  })

  it('restores a deleted key from its revisions, faithfully and in sequence', async () => {
    const ws = workspace('ws-restore')
    const env1 = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })

    // A flag with two versions, then deleted.
    await ws.setConfig({
      environmentId: env1.id,
      key: 'checkout-v2',
      kind: 'flag',
      content: '{"enabled":false}',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: env1.id,
      key: 'checkout-v2',
      kind: 'flag',
      content: '{"enabled":true}',
      userId: 'u1',
    })
    await ws.deleteConfig(env1.id, 'checkout-v2', 'u1')
    expect(await ws.getConfig(env1.id, 'checkout-v2')).toBeNull()

    // It shows up as restorable…
    const deleted = await ws.listDeletedConfigs(env1.id)
    expect(deleted.map((d) => d.key)).toContain('checkout-v2')
    expect(deleted.find((d) => d.key === 'checkout-v2')?.kind).toBe('flag')

    // …and comes back as a flag with the final content, continuing the
    // version sequence (v1, v2, delete-snapshot v3 → restored v4).
    const restored = await ws.restoreConfig(env1.id, 'checkout-v2', 'u2')
    expect(restored.kind).toBe('flag')
    expect(restored.content).toBe('{"enabled":true}')
    expect(restored.version).toBe(4)
    expect(await ws.listDeletedConfigs(env1.id)).toHaveLength(0)

    // Restoring a live key refuses.
    await expect(ws.restoreConfig(env1.id, 'checkout-v2', 'u2')).rejects.toThrow('already exists')

    // Encrypted secrets restore as encrypted secrets (ciphertext untouched).
    await ws.setConfig({
      environmentId: env1.id,
      key: 'api-token',
      kind: 'secret',
      content: 'ciphertext-blob',
      isEncrypted: true,
      userId: 'u1',
    })
    await ws.deleteConfig(env1.id, 'api-token', 'u1')
    const secret = await ws.restoreConfig(env1.id, 'api-token', 'u1')
    expect(secret.kind).toBe('secret')
    expect(secret.isEncrypted).toBe(true)
    expect(secret.content).toBe('ciphertext-blob')
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
