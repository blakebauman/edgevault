import { env } from 'cloudflare:test'
import type { AuditEvent } from '@edgevault/edge-protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { daysInRange, queryAuditHistory } from '../src/audit-query'

const NOW = Date.parse('2026-06-04T12:00:00Z')
const bucket = env.AUDIT_BUCKET

function ev(over: Partial<AuditEvent>): AuditEvent {
  return {
    at: NOW,
    workspaceId: 'ws-1',
    action: 'config.updated',
    resourceType: 'config',
    userId: 'u1',
    ...over,
  }
}

function put(day: string, suffix: string, events: AuditEvent[]) {
  return bucket.put(
    `audit/${day}/${suffix}.ndjson`,
    events.map((e) => JSON.stringify(e)).join('\n'),
  )
}

beforeAll(async () => {
  await put('2026-06-04', 'a', [
    ev({ at: Date.parse('2026-06-04T10:00:00Z'), key: 'today-1' }),
    ev({ at: Date.parse('2026-06-04T11:00:00Z'), key: 'today-2', environmentId: 'prod' }),
    ev({ at: NOW, workspaceId: 'ws-2', key: 'other-ws' }),
  ])
  await put('2026-06-02', 'b', [ev({ at: Date.parse('2026-06-02T09:00:00Z'), key: 'older' })])
  await put('2026-05-01', 'c', [ev({ at: Date.parse('2026-05-01T09:00:00Z'), key: 'way-old' })])
})

describe('daysInRange', () => {
  it('lists inclusive days and rejects an inverted range', () => {
    expect(daysInRange('2026-06-02', '2026-06-04')).toEqual([
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ])
    expect(daysInRange('2026-06-04', '2026-06-02')).toEqual([])
  })
})

describe('queryAuditHistory', () => {
  it('returns the workspace events in range, newest first, excluding other workspaces', async () => {
    const events = await queryAuditHistory(bucket, { workspaceId: 'ws-1', now: NOW })
    const keys = events.map((e) => e.key)
    expect(keys).toEqual(['today-2', 'today-1', 'older']) // newest first; default 7-day window
    expect(keys).not.toContain('other-ws')
    expect(keys).not.toContain('way-old') // outside the default window
  })

  it('filters by environment', async () => {
    const events = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      environmentId: 'prod',
      now: NOW,
    })
    expect(events.map((e) => e.key)).toEqual(['today-2'])
  })

  it('honors an explicit range and limit', async () => {
    const events = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      from: '2026-05-01',
      to: '2026-06-04',
      limit: 2,
      now: NOW,
    })
    expect(events).toHaveLength(2)
    expect(events[0]?.key).toBe('today-2')
  })
})
