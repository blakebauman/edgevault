import { describe, expect, it } from 'vitest'
import { mapCfErrors, mapCfToDomainStatus, validateCustomHostname } from '../src/custom-hostnames'

// Route handlers sit behind withDatabase (Neon), which the vitest pool can't
// provide (CI has no Postgres) — the testable surface here is the pure logic;
// the authz/404 gating follows the same inline pattern as organizations.ts.

describe('validateCustomHostname', () => {
  const ok = (h: string) => expect(validateCustomHostname(h, 'edgevault.io')).toBeNull()
  const bad = (h: string) => expect(validateCustomHostname(h, 'edgevault.io')).not.toBeNull()

  it('accepts ordinary customer hostnames', () => {
    ok('config.acme.com')
    ok('flags.staging.acme.co.uk')
    ok('a-1.example-app.dev')
  })

  it('rejects the platform domain and its subdomains', () => {
    bad('edgevault.io')
    bad('delivery.edgevault.io')
    bad('evil.edgevault.io')
  })

  it('rejects reserved/internal hostnames', () => {
    bad('localhost')
    bad('127.0.0.1')
    bad('::1')
    bad('vault.internal')
    bad('thing.local')
    bad('demo.example')
  })

  it('rejects wildcards, bare labels, and malformed names', () => {
    bad('*.acme.com')
    bad('acme')
    bad('-leading.acme.com')
    bad('sp ace.acme.com')
    bad(`${'a'.repeat(64)}.acme.com`)
    bad(`${'a.'.repeat(130)}com`)
  })
})

describe('mapCfToDomainStatus', () => {
  it('maps the CF lifecycle onto ours', () => {
    expect(mapCfToDomainStatus('pending')).toBe('pending_dcv')
    expect(mapCfToDomainStatus('active', 'pending_validation')).toBe('pending_ssl')
    expect(mapCfToDomainStatus('active', 'active')).toBe('active')
    expect(mapCfToDomainStatus('active')).toBe('active')
    expect(mapCfToDomainStatus('moved')).toBe('failed')
    expect(mapCfToDomainStatus('deleted')).toBe('failed')
    expect(mapCfToDomainStatus('blocked')).toBe('failed')
  })
})

describe('mapCfErrors', () => {
  it('translates known CF codes without leaking the vendor', () => {
    const messages = mapCfErrors([
      { code: 1414, message: 'cf internal' },
      { code: 1421, message: 'cf internal' },
      { code: 9999, message: 'cf internal' },
    ])
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatch(/another account/)
    expect(messages[1]).toMatch(/limit/)
    for (const m of messages) expect(m).not.toMatch(/cf internal|cloudflare/i)
  })

  it('falls back when CF returns no errors', () => {
    expect(mapCfErrors(undefined)).toHaveLength(1)
    expect(mapCfErrors([])).toHaveLength(1)
  })
})
