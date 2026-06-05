import type { AuditEvent } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import { EdgeReadMeter, FLUSH_INTERVAL_MS, FLUSH_THRESHOLD, flushMeter } from '../src/metering'

describe('EdgeReadMeter', () => {
  it('aggregates reads per workspace+environment', () => {
    const m = new EdgeReadMeter()
    m.record('ws1', 'env1', 3, 1000)
    m.record('ws1', 'env1', 2, 1000)
    m.record('ws1', 'env2', 1, 1000)
    expect(m.pending).toBe(6)
    const events = m.drain(2000)
    const byEnv = Object.fromEntries(events.map((e) => [e.environmentId, e.count]))
    expect(byEnv).toEqual({ env1: 5, env2: 1 })
    expect(events.every((e) => e.resourceType === 'edge_read' && e.action === 'edge.read')).toBe(
      true,
    )
    expect(m.pending).toBe(0) // drained
  })

  it('ignores non-positive counts', () => {
    const m = new EdgeReadMeter()
    m.record('ws', 'env', 0, 1000)
    m.record('ws', 'env', -5, 1000)
    expect(m.pending).toBe(0)
    expect(m.drain(1000)).toEqual([])
  })

  it('flushes once the count threshold is reached', () => {
    const m = new EdgeReadMeter()
    expect(m.shouldFlush(1000)).toBe(false)
    m.record('ws', 'env', FLUSH_THRESHOLD - 1, 1000)
    expect(m.shouldFlush(1000)).toBe(false)
    m.record('ws', 'env', 1, 1000)
    expect(m.shouldFlush(1000)).toBe(true)
  })

  it('flushes once the time interval elapses, even below the threshold', () => {
    const m = new EdgeReadMeter()
    m.record('ws', 'env', 1, 1000)
    expect(m.shouldFlush(1000 + FLUSH_INTERVAL_MS - 1)).toBe(false)
    expect(m.shouldFlush(1000 + FLUSH_INTERVAL_MS)).toBe(true)
  })

  it('resets the age clock after draining', () => {
    const m = new EdgeReadMeter()
    m.record('ws', 'env', 1, 1000)
    m.drain(1000)
    m.record('ws', 'env', 1, 5000) // new oldest = 5000
    expect(m.shouldFlush(5000 + FLUSH_INTERVAL_MS - 1)).toBe(false)
  })
})

describe('flushMeter', () => {
  it('sends drained events to the queue and empties the meter', async () => {
    const m = new EdgeReadMeter()
    m.record('ws', 'env', 4, 1000)
    const sent: AuditEvent[] = []
    const queue = {
      sendBatch: vi.fn(async (msgs: Iterable<{ body: AuditEvent }>) => {
        for (const msg of msgs) sent.push(msg.body)
      }),
    }
    await flushMeter(m, queue, 2000)
    expect(sent).toEqual([
      expect.objectContaining({ workspaceId: 'ws', environmentId: 'env', count: 4, at: 2000 }),
    ])
    expect(m.pending).toBe(0)
  })

  it('does not touch the queue when nothing is pending', async () => {
    const m = new EdgeReadMeter()
    const queue = { sendBatch: vi.fn(async () => {}) }
    await flushMeter(m, queue, 1000)
    expect(queue.sendBatch).not.toHaveBeenCalled()
  })
})
