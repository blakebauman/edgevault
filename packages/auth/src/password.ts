import { argon2id } from '@noble/hashes/argon2.js'
import { decodeBase64, encodeBase64 } from './encoding'

/**
 * Argon2id password hashing using a pure-JS, Workers-safe implementation
 * (@noble/hashes — no Node crypto, no native addon, no telemetry).
 *
 * Output is a self-describing PHC-style string so verification needs no
 * external parameter store:
 *   $argon2id$v=19$m=<mem>,t=<time>,p=<par>$<saltB64>$<hashB64>
 */

// OWASP-recommended Argon2id parameters (second option): 19 MiB, t=2, p=1.
const MEMORY_KIB = 19456
const TIME_COST = 2
const PARALLELISM = 1
const HASH_LEN = 32
const SALT_LEN = 16
const VERSION = 19

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const hash = argon2id(new TextEncoder().encode(password), salt, {
    t: TIME_COST,
    m: MEMORY_KIB,
    p: PARALLELISM,
    dkLen: HASH_LEN,
    version: VERSION,
  })
  return `$argon2id$v=${VERSION}$m=${MEMORY_KIB},t=${TIME_COST},p=${PARALLELISM}$${encodeBase64(
    salt,
  )}$${encodeBase64(hash)}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', '<salt>', '<hash>']
  const [, scheme, versionPart, paramPart, saltPart, hashPart] = encoded.split('$')
  if (scheme !== 'argon2id' || !versionPart || !paramPart || !saltPart || !hashPart) {
    return false
  }

  const version = Number.parseInt(versionPart.slice(2), 10)
  const params: Record<string, number> = {}
  for (const kv of paramPart.split(',')) {
    const [k, v] = kv.split('=')
    if (k && v) params[k] = Number.parseInt(v, 10)
  }
  const { m, t, p } = params
  if (!m || !t || !p) return false

  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = decodeBase64(saltPart)
    expected = decodeBase64(hashPart)
  } catch {
    return false
  }

  const actual = argon2id(new TextEncoder().encode(password), salt, {
    t,
    m,
    p,
    dkLen: expected.length,
    version,
  })
  return constantTimeEqual(actual, expected)
}

/** Constant-time compare over equal-length byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}
