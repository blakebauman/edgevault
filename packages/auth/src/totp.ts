import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

/**
 * TOTP (RFC 6238) / HOTP (RFC 4226) for multi-factor auth, built on
 * @noble/hashes (no telemetry, audited). Secrets are Base32 (RFC 4648) so they
 * paste straight into standard authenticator apps. Defaults match
 * those apps: SHA-1, 6 digits, 30-second period.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

const HASHES = { SHA1: sha1, SHA256: sha256, SHA512: sha512 } as const

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function decodeBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('Invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8)
  // 64-bit big-endian; counters stay well within 2^53 so split at 32 bits.
  let high = Math.floor(counter / 0x100000000)
  let low = counter >>> 0
  for (let i = 7; i >= 4; i--) {
    buf[i] = low & 0xff
    low = Math.floor(low / 256)
  }
  for (let i = 3; i >= 0; i--) {
    buf[i] = high & 0xff
    high = Math.floor(high / 256)
  }
  return buf
}

export interface OtpOptions {
  digits?: number
  algorithm?: TotpAlgorithm
}

/** RFC 4226 HOTP for a raw key + counter. */
export function hotp(key: Uint8Array, counter: number, options: OtpOptions = {}): string {
  const digits = options.digits ?? 6
  const hash = HASHES[options.algorithm ?? 'SHA1']
  const mac = hmac(hash, key, counterBytes(counter))
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff)
  return (binary % 10 ** digits).toString().padStart(digits, '0')
}

export interface TotpOptions extends OtpOptions {
  /** Step size in seconds (default 30). */
  period?: number
  /** Unix time in ms (default now). */
  now?: number
}

/** Current TOTP code for a Base32 secret. */
export function totp(secretBase32: string, options: TotpOptions = {}): string {
  const period = options.period ?? 30
  const now = options.now ?? Date.now()
  const counter = Math.floor(now / 1000 / period)
  return hotp(decodeBase32(secretBase32), counter, options)
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Accept codes ±window steps to tolerate clock drift (default 1). */
  window?: number
}

/** Constant-time verification of a submitted TOTP code, with a drift window. */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: VerifyTotpOptions = {},
): boolean {
  const digits = options.digits ?? 6
  const period = options.period ?? 30
  const window = options.window ?? 1
  const now = options.now ?? Date.now()
  const candidate = token.replace(/\s+/g, '')
  if (candidate.length !== digits) return false

  const key = decodeBase32(secretBase32)
  const counter = Math.floor(now / 1000 / period)
  let ok = false
  // Check the whole window (no early return) to keep timing independent of position.
  for (let i = -window; i <= window; i++) {
    if (constantTimeEqual(hotp(key, counter + i, options), candidate)) ok = true
  }
  return ok
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Generate a new Base32 TOTP secret (default 20 bytes / 160 bits, per RFC). */
export function generateTotpSecret(bytes = 20): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(bytes)))
}

export interface OtpauthUriInput {
  secret: string
  /** The account label, e.g. the user's email. */
  accountName: string
  /** The issuer shown in the authenticator app. */
  issuer: string
  digits?: number
  period?: number
  algorithm?: TotpAlgorithm
}

/** Build an otpauth:// URI for QR provisioning into an authenticator app. */
export function buildOtpauthUri(input: OtpauthUriInput): string {
  // Encode the issuer and account separately but keep the ":" label separator.
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: input.algorithm ?? 'SHA1',
    digits: String(input.digits ?? 6),
    period: String(input.period ?? 30),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
