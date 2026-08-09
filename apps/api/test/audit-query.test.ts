import { env } from 'cloudflare:test'
import type { AuditEvent } from '@edgevault/edge-protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildAuditExport, daysInRange, queryAuditHistory } from '../src/audit-query'

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
  await put('2026-06-03', 'd', [
    ev({
      at: Date.parse('2026-06-03T09:00:00Z'),
      key: 'db-password',
      action: 'secret.revealed',
      resourceType: 'secret',
      userId: 'u2',
    }),
    ev({
      at: Date.parse('2026-06-03T10:00:00Z'),
      action: 'alert.reveal_spike',
      resourceType: 'secret',
      userId: 'u2',
    }),
  ])
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
    const { events } = await queryAuditHistory(bucket, { workspaceId: 'ws-1', now: NOW })
    // newest first; default 7-day window
    expect(events.map((e) => `${e.action}:${e.key ?? ''}`)).toEqual([
      'config.updated:today-2',
      'config.updated:today-1',
      'alert.reveal_spike:',
      'secret.revealed:db-password',
      'config.updated:older',
    ])
    const keys = events.map((e) => e.key)
    expect(keys).not.toContain('other-ws')
    expect(keys).not.toContain('way-old') // outside the default window
  })

  it('filters by environment', async () => {
    const { events } = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      environmentId: 'prod',
      now: NOW,
    })
    expect(events.map((e) => e.key)).toEqual(['today-2'])
  })

  it('honors an explicit range and limit', async () => {
    const { events } = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      from: '2026-05-01',
      to: '2026-06-04',
      limit: 2,
      now: NOW,
    })
    expect(events).toHaveLength(2)
    expect(events[0]?.key).toBe('today-2')
  })

  it('filters by exact action and by action family prefix', async () => {
    const exact = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      action: 'secret.revealed',
      now: NOW,
    })
    expect(exact.events.map((e) => e.key)).toEqual(['db-password'])

    // `alert` catches the whole anomaly family without naming each rule
    const family = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      action: 'alert',
      now: NOW,
    })
    expect(family.events.map((e) => e.action)).toEqual(['alert.reveal_spike'])
  })

  it('filters by resource type and by actor', async () => {
    const secrets = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      resourceType: 'secret',
      now: NOW,
    })
    expect(secrets.events).toHaveLength(2)
    expect(secrets.total).toBe(2)

    const byActor = await queryAuditHistory(bucket, { workspaceId: 'ws-1', userId: 'u2', now: NOW })
    expect(byActor.events.every((e) => e.userId === 'u2')).toBe(true)
    expect(byActor.events).toHaveLength(2)
  })

  it('reports facets across the whole scope, not just the filtered slice', async () => {
    const { events, facets } = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      action: 'secret.revealed',
      now: NOW,
    })
    expect(events).toHaveLength(1)
    // the filter narrowed the rows but the options stay complete, so the
    // console can offer a different action without a second round trip
    expect(facets.actions).toEqual(['alert.reveal_spike', 'config.updated', 'secret.revealed'])
    expect(facets.resourceTypes).toEqual(['config', 'secret'])
    expect(facets.userIds).toEqual(['u1', 'u2'])
  })

  it('scopes facets to the environment filter', async () => {
    const { facets } = await queryAuditHistory(bucket, {
      workspaceId: 'ws-1',
      environmentId: 'prod',
      now: NOW,
    })
    expect(facets.actions).toEqual(['config.updated'])
    expect(facets.userIds).toEqual(['u1'])
  })
})

describe('buildAuditExport', () => {
  it('hashes exactly the bytes it returns, over real warehouse content', async () => {
    const { events } = await queryAuditHistory(bucket, { workspaceId: 'ws-1', now: NOW })
    expect(events.length).toBeGreaterThan(0)

    const { ndjson, sha256 } = await buildAuditExport(events)

    // One JSON object per line, and every line is parseable — this is the file
    // a reviewer feeds to jq, so a trailing blank line or a wrapping array
    // would be a real defect.
    const lines = ndjson.split('\n')
    expect(lines).toHaveLength(events.length)
    expect(lines.every((l) => JSON.parse(l).workspaceId === 'ws-1')).toBe(true)

    // Recompute the way `shasum -a 256 export.ndjson` would.
    const expected = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ndjson))),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(sha256).toBe(expected)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the digest when a single event changes', async () => {
    const { events } = await queryAuditHistory(bucket, { workspaceId: 'ws-1', now: NOW })
    const before = await buildAuditExport(events)
    const tampered = events.map((e, i) => (i === 0 ? { ...e, action: 'config.deleted' } : e))
    const after = await buildAuditExport(tampered)
    expect(after.sha256).not.toBe(before.sha256)
  })

  it('is stable for an empty result rather than throwing', async () => {
    const { ndjson, sha256 } = await buildAuditExport([])
    expect(ndjson).toBe('')
    // SHA-256 of the empty string.
    expect(sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
