import { sha256 } from '@noble/hashes/sha2.js'
import { encodeBase64urlNoPadding, encodeHexLowerCase } from './encoding'

/**
 * Opaque token + API-key helpers. We never store raw tokens — only their
 * SHA-256 hash — so a database leak cannot resurrect live sessions or keys.
 */

/** Cryptographically-random URL-safe token (default 256 bits of entropy). */
export function generateToken(bytes = 32): string {
  return encodeBase64urlNoPadding(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** SHA-256 hex digest of a token, for storage and indexed lookup. */
export function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
}

export interface GeneratedApiKey {
  /** The full secret shown to the user exactly once: `evk_live_<random>`. */
  key: string
  /** Short, non-secret identifier persisted for display: first 16 chars. */
  prefix: string
  /** SHA-256 hex of the full key, persisted for verification. */
  keyHash: string
}

export function generateApiKey(scope: 'live' | 'test' = 'live'): GeneratedApiKey {
  const secret = encodeBase64urlNoPadding(crypto.getRandomValues(new Uint8Array(24)))
  const key = `evk_${scope}_${secret}`
  return { key, prefix: key.slice(0, 16), keyHash: hashToken(key) }
}
