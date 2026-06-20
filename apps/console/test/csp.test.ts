import { describe, expect, it } from 'vitest'
import { buildCsp, generateNonce } from '../app/lib/csp'

describe('buildCsp', () => {
  it('nonce-gates scripts and locks framing', () => {
    const csp = buildCsp('abc123', 'wss://api.example')
    expect(csp).toContain("script-src 'self' 'nonce-abc123'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
  })

  it('allows the API websocket + matching https origin only when configured', () => {
    // The assistant's Agents SDK client needs both wss:// (socket) and https://
    // (the get-messages history fetch) to the API host.
    expect(buildCsp('n', 'wss://api.example')).toContain(
      "connect-src 'self' wss://api.example https://api.example",
    )
    expect(buildCsp('n')).toContain("connect-src 'self';")
  })

  it('permits the webfont origins and nothing else by default', () => {
    const csp = buildCsp('n')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('font-src https://fonts.gstatic.com')
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")
  })
})

describe('generateNonce', () => {
  it('returns unique base64 values', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})
