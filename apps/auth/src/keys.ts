import { importSigningKey, type JWK, type SigningKey } from '@edgevault/auth'

/**
 * Load and cache the EdDSA signing key (and its public JWK) for this isolate.
 * The private JWK comes from the JWT_PRIVATE_JWK secret; the public JWK is the
 * private one with its private scalar (`d`) stripped.
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
  const { d: _private, ...rest } = privateJwk
  cache = { signing, publicJwk: { ...rest, kid: signing.kid } }
  return cache
}
