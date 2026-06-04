import { describe, expect, it } from 'vitest'
import { parseWorkspaceEvent, type WorkspaceEvent } from '../src/events'

describe('parseWorkspaceEvent', () => {
  it('parses a valid event', () => {
    const event: WorkspaceEvent = {
      type: 'config.changed',
      environmentId: 'e1',
      key: 'k',
      kind: 'flag',
      version: 2,
      at: 1,
    }
    expect(parseWorkspaceEvent(JSON.stringify(event))).toEqual(event)
  })

  it('returns null for malformed or typeless payloads', () => {
    expect(parseWorkspaceEvent('not json')).toBeNull()
    expect(parseWorkspaceEvent('{"no":"type"}')).toBeNull()
  })
})
