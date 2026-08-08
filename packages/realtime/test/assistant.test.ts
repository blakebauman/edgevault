import { describe, expect, it } from 'vitest'
import { assistantSocketUrl, parseAssistantMessage } from '../src/assistant'

describe('assistantSocketUrl', () => {
  const base = { host: 'api.edgevault.io', name: 'ws-1:user-1:v2', token: 'tok' }

  it('adds a scheme to a bare authority', () => {
    // The regression this exists for: the console stores the host without one,
    // and a schemeless url never connects.
    const url = assistantSocketUrl({ ...base, pageProtocol: 'https:' })
    expect(url.startsWith('wss://api.edgevault.io/')).toBe(true)
  })

  it('uses ws:// on an http page so local dev works', () => {
    const url = assistantSocketUrl({ ...base, host: 'localhost:8790', pageProtocol: 'http:' })
    expect(url.startsWith('ws://localhost:8790/')).toBe(true)
  })

  it('tolerates a host that already carries a scheme or trailing slash', () => {
    const url = assistantSocketUrl({
      ...base,
      host: 'wss://api.edgevault.io/',
      pageProtocol: 'https:',
    })
    expect(url.startsWith('wss://api.edgevault.io/agents/')).toBe(true)
    expect(url).not.toContain('//agents')
  })

  it('encodes the instance name and token', () => {
    const url = assistantSocketUrl({
      ...base,
      name: 'a b:c',
      token: 'a/b+c',
      pageProtocol: 'https:',
    })
    expect(url).toContain('/agents/edge-vault-agent/a%20b%3Ac?')
    expect(url).toContain('token=a%2Fb%2Bc')
  })
})

describe('parseAssistantMessage', () => {
  it('accepts turn-scoped frames', () => {
    expect(parseAssistantMessage('{"type":"delta","turn":"t1","text":"hi"}')).toEqual({
      type: 'delta',
      turn: 't1',
      text: 'hi',
    })
  })

  it('accepts pong without a turn', () => {
    expect(parseAssistantMessage('{"type":"pong","at":1}')).toEqual({ type: 'pong', at: 1 })
  })

  it('rejects a turn-scoped frame with no turn', () => {
    // Dropping these is what stops text being attributed to the wrong turn.
    expect(parseAssistantMessage('{"type":"delta","text":"hi"}')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseAssistantMessage('not json')).toBeNull()
    expect(parseAssistantMessage('{"no":"type"}')).toBeNull()
  })
})
