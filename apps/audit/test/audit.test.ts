import { env } from 'cloudflare:test'
import type { AuditEvent } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import worker, { buildObjectKey, serializeBatch } from '../src/index'

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    at: 1,
    workspaceId: 'w',
    action: 'config.created',
    resourceType: 'flag',
    key: 'k',
    userId: 'u',
    ...over,
  }
}

function batch(events: AuditEvent[]) {
  const ackAll = vi.fn()
  const retryAll = vi.fn()
  return {
    queue: 'edgevault-audit',
    messages: events.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    })),
    ackAll,
    retryAll,
  } as unknown as MessageBatch<AuditEvent> & { ackAll: typeof ackAll; retryAll: typeof retryAll }
}

describe('audit helpers', () => {
  it('partitions object keys by date', () => {
    expect(buildObjectKey(new Date('2026-06-03T10:00:00Z'), 'abc')).toMatch(
      /^audit\/2026-06-03\/\d+-abc\.ndjson$/,
    )
  })
  it('serializes a batch as NDJSON', () => {
    expect(serializeBatch([event({ key: 'a' }), event({ key: 'b' })]).split('\n')).toHaveLength(2)
  })
})

describe('audit consumer', () => {
  it('archives a batch to R2 and acks', async () => {
    const b = batch([event({ key: 'one' }), event({ key: 'two' })])
    await worker.queue?.(b, env)
    expect(b.ackAll).toHaveBeenCalled()

    const listed = await env.AUDIT_BUCKET.list({ prefix: 'audit/' })
    expect(listed.objects.length).toBeGreaterThan(0)
    const obj = await env.AUDIT_BUCKET.get(listed.objects[0]!.key)
    const lines = (await obj!.text()).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).key).toBe('one')
  })

  it('ignores an empty batch', async () => {
    const b = batch([])
    await worker.queue?.(b, env)
    expect(b.ackAll).not.toHaveBeenCalled()
  })
})
