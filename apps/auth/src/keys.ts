import { importSigningKey, type JWK, type SigningKey } from '@edgevault/auth'

/**
 * Load and cache the EdDSA signing key (and its public JWK) for this isolate.
 * The private JWK comes from the JWT_PRIVATE_JWK secret; the public JWK is the
 * private one with its private scalar (`d`) stripped — and, like buildJwks,
 * with `key_ops`/`ext` dropped: a JWK exported from WebCrypto carries
 * `key_ops:["sign"]`, and workerd's (spec-strict) importKey refuses to use
 * such a key for verification. Node is lenient, which is why local tests
 * never caught the broken `requireUser` path on deployed workers.
 */
let cache: { signing: SigningKey; publicJwk: JWK } | null = null

export async function getKeys(env: Env): Promise<{ signing: SigningKey; publicJwk: JWK }> {
  if (cache) return cache
  let privateJwk: JWK
  try {
    privateJwk = JSON.parse(env.JWT_PRIVATE_JWK) as JWK
  } catch {
    throw new Error('JWT_PRIVATE_JWK is missing or not valid JSON')
  }
  const signing = await importSigningKey(privateJwk)
  const { d: _private, key_ops: _ops, ext: _ext, ...rest } = privateJwk
  cache = { signing, publicJwk: { ...rest, kid: signing.kid } }
  return cache
}
