import {
  buildOtpauthUri,
  generateTotpSecret,
  hashToken,
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
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  type Database,
  deleteRecoveryCodes,
  deleteTotpCredential,
  getTotpCredential,
  replaceRecoveryCodes,
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
): Promise<{ enabled: boolean; pending: boolean; recoveryCodesRemaining: number }> {
  const cred = await getTotpCredential(database, userId)
  const enabled = Boolean(cred?.confirmedAt)
  return {
    enabled,
    pending: Boolean(cred && !cred.confirmedAt),
    recoveryCodesRemaining: enabled ? await countUnusedRecoveryCodes(database, userId) : 0,
  }
}

// --- Recovery codes ----------------------------------------------------------
// One-time fallback when the authenticator device is lost. 10 codes of 40 bits
// each (hex, xxxxx-xxxxx), hashed at rest, consumed atomically.

const RECOVERY_CODE_COUNT = 10

function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 5)}-${hex.slice(5)}`
}

/** Lowercase + strip separators so codes survive copy/paste formatting. */
function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^0-9a-f]/g, '')
}

/** Issue a fresh set, invalidating any previous codes. Plaintext returned once. */
export async function generateRecoveryCodes(database: Database, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  await replaceRecoveryCodes(
    database,
    userId,
    codes.map((code) => hashToken(normalizeRecoveryCode(code))),
  )
  return codes
}

/** Consume a recovery code as the second factor. */
export async function verifyRecoveryCode(
  database: Database,
  userId: string,
  input: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input)
  if (normalized.length !== 10) return false
  return consumeRecoveryCode(database, userId, hashToken(normalized))
}

/** Remove all recovery codes (TOTP disabled — they'd be an orphaned factor). */
export async function clearRecoveryCodes(database: Database, userId: string): Promise<void> {
  await deleteRecoveryCodes(database, userId)
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
