import { describe, expect, it } from 'vitest'
import {
  decodeBase64,
  decodeBase64url,
  decodeHex,
  encodeBase64,
  encodeBase64urlNoPadding,
  encodeHexLowerCase,
} from '../src/encoding'
import {
  buildJwks,
  createJwkSet,
  generateApiKey,
  generateSigningKeyPair,
  generateToken,
  hashPassword,
  hashToken,
  importSigningKey,
  importVerificationKey,
  REVEAL_TOKEN_AUDIENCE,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  verifyWithJwkSet,
} from '../src/index'

describe('encoding', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])

  it('round-trips base64', () => {
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes)
  })

  it('round-trips base64url (no padding, url-safe alphabet)', () => {
    const encoded = encodeBase64urlNoPadding(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(decodeBase64url(encoded)).toEqual(bytes)
  })

  it('round-trips hex', () => {
    expect(encodeHexLowerCase(bytes)).toBe('000102fafbfcfdfeff')
    expect(decodeHex(encodeHexLowerCase(bytes))).toEqual(bytes)
  })
})

describe('password (Argon2id)', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('right')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('produces a unique salt per hash', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })

  it('rejects malformed encodings without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})

describe('tokens', () => {
  it('generates url-safe tokens and stable hashes', () => {
    const token = generateToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).toHaveLength(64)
  })

  it('generates prefixed API keys with a matching hash', () => {
    const { key, prefix, keyHash } = generateApiKey('live')
    expect(key.startsWith('evk_live_')).toBe(true)
    expect(key.startsWith(prefix)).toBe(true)
    expect(keyHash).toBe(hashToken(key))
  })
})

describe('jwt (EdDSA)', () => {
  it('signs and verifies an access token, exposes a JWKS', async () => {
    const { privateJwk, publicJwk, kid } = await generateSigningKeyPair()
    const signing = await importSigningKey(privateJwk)
    const verification = await importVerificationKey(publicJwk)

    const token = await signAccessToken({ sub: 'user-1', org: 'org-1', role: 'owner' }, signing, {
      issuer: 'https://auth.edgevault.test',
      expiresIn: '5m',
    })

    const claims = await verifyAccessToken(token, verification, {
      issuer: 'https://auth.edgevault.test',
    })
    expect(claims.sub).toBe('user-1')
    expect(claims.org).toBe('org-1')

    const jwks = buildJwks([publicJwk])
    expect(jwks.keys[0]?.kid).toBe(kid)
    expect(jwks.keys[0]?.use).toBe('sig')
  })

  it('rejects a token with the wrong issuer', async () => {
    const { privateJwk, publicJwk } = await generateSigningKeyPair()
    const signing = await importSigningKey(privateJwk)
    const verification = await importVerificationKey(publicJwk)
    const token = await signAccessToken({ sub: 'u' }, signing, { issuer: 'https://a.test' })
    await expect(
      verifyAccessToken(token, verification, { issuer: 'https://b.test' }),
    ).rejects.toThrow()
  })

  it('verifies against a JWKS resolver (as api does)', async () => {
    const { privateJwk, publicJwk } = await generateSigningKeyPair()
    const signing = await importSigningKey(privateJwk)
    const jwkSet = createJwkSet(buildJwks([publicJwk]))

    const token = await signAccessToken({ sub: 'user-9', org: 'org-9' }, signing, {
      issuer: 'https://auth.edgevault.test',
    })
    const claims = await verifyWithJwkSet(token, jwkSet, {
      issuer: 'https://auth.edgevault.test',
    })
    expect(claims.sub).toBe('user-9')
    expect(claims.org).toBe('org-9')

    // A different key's JWKS must not verify it.
    const other = await generateSigningKeyPair()
    const otherSet = createJwkSet(buildJwks([other.publicJwk]))
    await expect(
      verifyWithJwkSet(token, otherSet, { issuer: 'https://auth.edgevault.test' }),
    ).rejects.toThrow()
  })

  it('isolates the reveal-token audience from access tokens (both directions)', async () => {
    const { privateJwk, publicJwk } = await generateSigningKeyPair()
    const signing = await importSigningKey(privateJwk)
    const jwkSet = createJwkSet(buildJwks([publicJwk]))
    const issuer = 'https://auth.edgevault.test'

    // A reveal token (as `auth` mints it) verifies only against its own audience.
    const revealToken = await signAccessToken({ sub: 'user-7' }, signing, {
      issuer,
      audience: REVEAL_TOKEN_AUDIENCE,
      expiresIn: '5m',
    })
    const claims = await verifyWithJwkSet(revealToken, jwkSet, {
      issuer,
      audience: REVEAL_TOKEN_AUDIENCE,
    })
    expect(claims.sub).toBe('user-7')

    // A plain access token (audience defaults to issuer) must NOT satisfy a
    // reveal check — being signed in isn't a fresh step-up.
    const accessToken = await signAccessToken({ sub: 'user-7' }, signing, { issuer })
    await expect(
      verifyWithJwkSet(accessToken, jwkSet, { issuer, audience: REVEAL_TOKEN_AUDIENCE }),
    ).rejects.toThrow()

    // And a reveal token must NOT be usable as a normal access token.
    await expect(verifyWithJwkSet(revealToken, jwkSet, { issuer })).rejects.toThrow()
  })
})
