import { describe, expect, it } from 'vitest'
import {
  buildOtpauthUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  totp,
  verifyTotp,
  verifyTotpWithStep,
} from '../src/totp'

// RFC 6238 Appendix B test seed (ASCII "12345678901234567890") as Base32.
const SEED_ASCII = '12345678901234567890'
const SEED_B32 = encodeBase32(new TextEncoder().encode(SEED_ASCII))

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 32])
    expect([...decodeBase32(encodeBase32(bytes))]).toEqual([...bytes])
  })

  it('is case-insensitive and ignores whitespace/padding', () => {
    const enc = encodeBase32(new TextEncoder().encode('hello'))
    expect([...decodeBase32(enc.toLowerCase())]).toEqual([...decodeBase32(enc)])
  })
})

describe('TOTP RFC 6238 vectors (SHA-1, 8 digits)', () => {
  // (unix seconds, expected 8-digit code) from RFC 6238 Appendix B.
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [seconds, expected] of cases) {
    it(`T=${seconds} → ${expected}`, () => {
      expect(totp(SEED_B32, { now: seconds * 1000, digits: 8 })).toBe(expected)
    })
  }
})

describe('verifyTotp', () => {
  it('accepts the current code', () => {
    const now = Date.now()
    const code = totp(SEED_B32, { now })
    expect(verifyTotp(SEED_B32, code, { now })).toBe(true)
  })

  it('tolerates one step of drift within the window', () => {
    const now = 1_000_000 * 1000
    const prev = totp(SEED_B32, { now: now - 30_000 })
    expect(verifyTotp(SEED_B32, prev, { now, window: 1 })).toBe(true)
    expect(verifyTotp(SEED_B32, prev, { now, window: 0 })).toBe(false)
  })

  it('rejects a wrong code and a wrong length', () => {
    const now = Date.now()
    expect(verifyTotp(SEED_B32, '000000', { now })).toBe(false)
    expect(verifyTotp(SEED_B32, '1234', { now })).toBe(false)
  })

  it('rejects a code from a different secret', () => {
    const now = Date.now()
    const other = generateTotpSecret()
    const code = totp(other, { now })
    // 1-in-10^6 chance of a coincidental match; pin the timestamp for determinism.
    expect(verifyTotp(SEED_B32, code, { now })).toBe(false)
  })
})

describe('verifyTotpWithStep', () => {
  it('returns the matched counter step for the current code', () => {
    const now = 1_000_000 * 1000
    const code = totp(SEED_B32, { now })
    expect(verifyTotpWithStep(SEED_B32, code, { now })).toBe(Math.floor(now / 1000 / 30))
  })

  it('returns the previous step for a drifted code', () => {
    const now = 1_000_000 * 1000
    const prev = totp(SEED_B32, { now: now - 30_000 })
    expect(verifyTotpWithStep(SEED_B32, prev, { now, window: 1 })).toBe(
      Math.floor(now / 1000 / 30) - 1,
    )
  })

  it('returns null for a wrong code', () => {
    expect(verifyTotpWithStep(SEED_B32, '000000', { now: 1_000_000 * 1000 })).toBeNull()
  })
})

describe('provisioning', () => {
  it('generates a 32-char (160-bit) Base32 secret by default', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('builds a scannable otpauth URI', () => {
    const uri = buildOtpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      accountName: 'ada@example.com',
      issuer: 'EdgeVault',
    })
    expect(uri).toContain('otpauth://totp/EdgeVault:ada%40example.com')
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('issuer=EdgeVault')
    expect(uri).toContain('algorithm=SHA1')
  })
})
