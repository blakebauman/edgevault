import {
  createAuthenticator,
  type Database,
  getAuthenticatorById,
  getAuthenticatorsByUser,
  updateAuthenticatorCounter,
} from '@edgevault/database'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

/**
 * WebAuthn / passkeys for the auth worker, built on @simplewebauthn/server
 * (audited, edge-compatible). The console BFF supplies the expected rpID/origin
 * (derived from its own request) and round-trips the per-ceremony challenge in a
 * cookie; this worker owns option generation, verification, and the credential
 * store. Discoverable credentials enable usernameless login.
 */

const RP_NAME = 'EdgeVault'
const encoder = new TextEncoder()

function toBase64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64url(input: string): Uint8Array<ArrayBuffer> {
  const b = input.replaceAll('-', '+').replaceAll('_', '/')
  const padded = b.padEnd(Math.ceil(b.length / 4) * 4, '=')
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function buildRegistrationOptions(
  database: Database,
  input: { userId: string; userName: string; rpID: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await getAuthenticatorsByUser(database, input.userId)
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: input.rpID,
    userName: input.userName,
    userID: new Uint8Array(encoder.encode(input.userId)),
    attestationType: 'none',
    excludeCredentials: existing.map((a) => ({
      id: a.id,
      transports: a.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
}

export async function verifyRegistration(
  database: Database,
  input: {
    userId: string
    response: RegistrationResponseJSON
    expectedChallenge: string
    expectedOrigin: string
    expectedRPID: string
  },
): Promise<boolean> {
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
  })
  if (!verification.verified || !verification.registrationInfo) return false
  const { credential } = verification.registrationInfo
  await createAuthenticator(database, {
    id: credential.id,
    userId: input.userId,
    publicKey: toBase64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
  })
  return true
}

export async function buildAuthenticationOptions(
  rpID: string,
  // Login stays 'preferred' (usernameless UX); step-up before a secret reveal
  // passes 'required' so the assertion proves a verified factor (PIN/biometric),
  // not mere possession.
  userVerification: 'preferred' | 'required' = 'preferred',
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials → discoverable (usernameless) login.
  return generateAuthenticationOptions({ rpID, userVerification })
}

/** Verify a passkey assertion. Returns the authenticated user id, or null. */
export async function verifyAuthentication(
  database: Database,
  input: {
    response: AuthenticationResponseJSON
    expectedChallenge: string
    expectedOrigin: string
    expectedRPID: string
    /** Reject the assertion unless the authenticator performed user verification. */
    requireUserVerification?: boolean
  },
): Promise<string | null> {
  const authenticator = await getAuthenticatorById(database, input.response.id)
  if (!authenticator) return null

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    credential: {
      id: authenticator.id,
      publicKey: fromBase64url(authenticator.publicKey),
      counter: authenticator.counter,
      transports: authenticator.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: input.requireUserVerification ?? false,
  })
  if (!verification.verified) return null

  // Advance the signature counter to detect cloned authenticators.
  await updateAuthenticatorCounter(
    database,
    authenticator.id,
    verification.authenticationInfo.newCounter,
  )
  return authenticator.userId
}
