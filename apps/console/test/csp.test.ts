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

  it('allows the realtime websocket origin only when configured', () => {
    expect(buildCsp('n', 'wss://api.example')).toContain("connect-src 'self' wss://api.example")
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
