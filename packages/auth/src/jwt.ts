import * as jose from 'jose'

/**
 * Stateless JWT signing/verification with EdDSA (Ed25519). Access tokens let
 * `api`/`delivery` verify a caller without a round-trip to `auth`, using the
 * public key published at the JWKS endpoint.
 */

const ALG = 'EdDSA'

export interface AccessTokenClaims extends jose.JWTPayload {
  /** Subject — the user id. */
  sub: string
  /** Active organization id, if any. */
  org?: string
  /** Coarse role within the active org. */
  role?: string
}

export interface SigningKey {
  privateKey: jose.CryptoKey
  kid: string
}

export interface VerificationKey {
  publicKey: jose.CryptoKey
  kid: string
}

export async function generateSigningKeyPair(): Promise<{
  privateJwk: jose.JWK
  publicJwk: jose.JWK
  kid: string
}> {
  const { privateKey, publicKey } = await jose.generateKeyPair(ALG, { extractable: true })
  const privateJwk = await jose.exportJWK(privateKey)
  const publicJwk = await jose.exportJWK(publicKey)
  const kid = await jose.calculateJwkThumbprint(publicJwk)
  return {
    privateJwk: { ...privateJwk, kid, alg: ALG },
    publicJwk: { ...publicJwk, kid, alg: ALG },
    kid,
  }
}

export async function importSigningKey(privateJwk: jose.JWK): Promise<SigningKey> {
  const privateKey = (await jose.importJWK(privateJwk, ALG)) as jose.CryptoKey
  const kid = privateJwk.kid ?? (await jose.calculateJwkThumbprint(privateJwk))
  return { privateKey, kid }
}

export async function importVerificationKey(publicJwk: jose.JWK): Promise<VerificationKey> {
  const publicKey = (await jose.importJWK(publicJwk, ALG)) as jose.CryptoKey
  const kid = publicJwk.kid ?? (await jose.calculateJwkThumbprint(publicJwk))
  return { publicKey, kid }
}

export interface SignOptions {
  issuer: string
  audience?: string
  expiresIn?: string | number
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  key: SigningKey,
  opts: SignOptions,
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setSubject(claims.sub)
    .setAudience(opts.audience ?? opts.issuer)
    .setExpirationTime(opts.expiresIn ?? '15m')
    .sign(key.privateKey)
}

export async function verifyAccessToken(
  token: string,
  key: VerificationKey,
  opts: { issuer: string; audience?: string },
): Promise<AccessTokenClaims> {
  const { payload } = await jose.jwtVerify(token, key.publicKey, {
    algorithms: [ALG],
    issuer: opts.issuer,
    audience: opts.audience ?? opts.issuer,
  })
  return payload as AccessTokenClaims
}

/** Build a JWKS document for the public verification key(s). */
export function buildJwks(publicJwks: jose.JWK[]): { keys: jose.JWK[] } {
  return { keys: publicJwks.map((jwk) => ({ ...jwk, use: 'sig', alg: ALG })) }
}

export type JwkSet = ReturnType<typeof jose.createLocalJWKSet>

/** Build a reusable key resolver from a JWKS document (handles multiple kids). */
export function createJwkSet(jwks: { keys: jose.JWK[] }): JwkSet {
  return jose.createLocalJWKSet(jwks as jose.JSONWebKeySet)
}

/** Verify an access token against a JWKS resolver (for api/delivery). */
export async function verifyWithJwkSet(
  token: string,
  jwkSet: JwkSet,
  opts: { issuer: string; audience?: string },
): Promise<AccessTokenClaims> {
  const { payload } = await jose.jwtVerify(token, jwkSet, {
    algorithms: [ALG],
    issuer: opts.issuer,
    audience: opts.audience ?? opts.issuer,
  })
  return payload as AccessTokenClaims
}

export type { JWK } from 'jose'
