import {
  buildOtpauthUri,
  generateTotpSecret,
  importVerificationKey,
  REVEAL_TOKEN_AUDIENCE,
  signAccessToken,
  verifyAccessToken,
  verifyTotpWithStep,
} from '@edgevault/auth'
import { decryptSecret, encryptSecret, isSecretEnvelope } from '@edgevault/crypto'
import {
  claimTotpStep,
  confirmTotpCredential,
  type Database,
  deleteTotpCredential,
  getTotpCredential,
  upsertTotpSecret,
} from '@edgevault/database'
import { getKeys } from './keys'

/**
 * TOTP multi-factor auth for the auth worker. The shared secret is envelope-
 * encrypted (keyed by user id) via @edgevault/crypto and only ever decrypted in
 * this worker to verify a code. Between sign-in and the second factor we mint a
 * short-lived signed "MFA challenge" token (a JWT with audience `mfa-challenge`)
 * so a half-authenticated request can't be used as a real access token.
 */

const MFA_AUDIENCE = 'mfa-challenge'
const ISSUER_NAME = 'EdgeVault'

/**
 * Verify a code and claim its counter step so the same code can't be accepted
 * twice (TOTP replay). Every code-checking path goes through this — a code
 * spent on enrollment/disable can't be replayed at sign-in either.
 */
async function verifyAndClaimCode(
  database: Database,
  userId: string,
  secret: string,
  code: string,
): Promise<boolean> {
  const step = verifyTotpWithStep(secret, code)
  if (step === null) return false
  return claimTotpStep(database, userId, step)
}

function decryptStoredSecret(env: Env, userId: string, stored: string): Promise<string> {
  const parsed: unknown = JSON.parse(stored)
  if (!isSecretEnvelope(parsed)) throw new Error('Corrupt TOTP secret')
  return decryptSecret(env.MASTER_KEK, userId, parsed)
}

/** Begin enrollment: generate + store an unconfirmed secret, return provisioning data. */
export async function startTotpEnrollment(
  env: Env,
  database: Database,
  userId: string,
  accountName: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret()
  const envelope = await encryptSecret(env.MASTER_KEK, userId, secret)
  await upsertTotpSecret(database, userId, JSON.stringify(envelope))
  return { secret, otpauthUri: buildOtpauthUri({ secret, accountName, issuer: ISSUER_NAME }) }
}

/** Confirm enrollment by verifying the first code; marks the credential active. */
export async function confirmTotpEnrollment(
  env: Env,
  database: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const cred = await getTotpCredential(database, userId)
  if (!cred) return false
  const secret = await decryptStoredSecret(env, userId, cred.encryptedSecret)
  if (!(await verifyAndClaimCode(database, userId, secret, code))) return false
  await confirmTotpCredential(database, userId)
  return true
}

/** Disable MFA — requires a currently-valid code so a hijacked session can't strip it. */
export async function disableTotp(
  env: Env,
  database: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const cred = await getTotpCredential(database, userId)
  if (!cred?.confirmedAt) return false
  const secret = await decryptStoredSecret(env, userId, cred.encryptedSecret)
  if (!(await verifyAndClaimCode(database, userId, secret, code))) return false
  await deleteTotpCredential(database, userId)
  return true
}

/** Verify a code against a user's confirmed credential (sign-in second factor). */
export async function verifyUserTotp(
  env: Env,
  database: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const cred = await getTotpCredential(database, userId)
  if (!cred?.confirmedAt) return false
  const secret = await decryptStoredSecret(env, userId, cred.encryptedSecret)
  return verifyAndClaimCode(database, userId, secret, code)
}

export async function totpStatus(
  database: Database,
  userId: string,
): Promise<{ enabled: boolean; pending: boolean }> {
  const cred = await getTotpCredential(database, userId)
  return { enabled: Boolean(cred?.confirmedAt), pending: Boolean(cred && !cred.confirmedAt) }
}

/** Has the user enabled (confirmed) MFA? Used by sign-in to decide on a challenge. */
export async function userHasMfa(database: Database, userId: string): Promise<boolean> {
  const cred = await getTotpCredential(database, userId)
  return Boolean(cred?.confirmedAt)
}

/** Mint a short-lived MFA challenge token after a correct password. */
export async function signMfaChallenge(env: Env, userId: string): Promise<string> {
  const { signing } = await getKeys(env)
  return signAccessToken({ sub: userId }, signing, {
    issuer: env.AUTH_ISSUER,
    audience: MFA_AUDIENCE,
    expiresIn: '5m',
  })
}

/**
 * Mint a short-lived step-up token after a fresh second-factor proof. Required
 * by the secret-reveal path so being signed in isn't enough — revealing a secret
 * costs a fresh proof of presence. Verified in `api` against the JWKS by its
 * `secret-reveal` audience; lives only ~5 minutes.
 */
export async function signRevealToken(
  env: Env,
  userId: string,
  org: string | null,
): Promise<string> {
  const { signing } = await getKeys(env)
  return signAccessToken({ sub: userId, ...(org ? { org } : {}) }, signing, {
    issuer: env.AUTH_ISSUER,
    audience: REVEAL_TOKEN_AUDIENCE,
    expiresIn: '5m',
  })
}

/** Verify an MFA challenge token; returns the user id or null if invalid/expired. */
export async function verifyMfaChallenge(env: Env, token: string): Promise<string | null> {
  try {
    const { publicJwk } = await getKeys(env)
    const key = await importVerificationKey(publicJwk)
    const claims = await verifyAccessToken(token, key, {
      issuer: env.AUTH_ISSUER,
      audience: MFA_AUDIENCE,
    })
    return claims.sub
  } catch {
    return null
  }
}
