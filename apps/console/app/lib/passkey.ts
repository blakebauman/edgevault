/**
 * Client-side passkey helpers. @simplewebauthn/browser is dynamically imported
 * so it never evaluates during SSR (it touches browser globals). Each function
 * runs the WebAuthn ceremony and round-trips through the /api/passkey BFF route.
 */

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

type Result = { ok: boolean; error?: string }

async function post(intent: string, response?: unknown): Promise<Response> {
  return fetch('/api/passkey', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, response }),
  })
}

export async function registerPasskey(): Promise<Result> {
  const { startRegistration } = await import('@simplewebauthn/browser')
  const optRes = await post('register-options')
  if (!optRes.ok) return { ok: false, error: 'Could not start passkey registration.' }
  const optionsJSON = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON
  let attestation: unknown
  try {
    attestation = await startRegistration({ optionsJSON })
  } catch {
    return { ok: false, error: 'Passkey registration was cancelled.' }
  }
  const verifyRes = await post('register-verify', attestation)
  const data = (await verifyRes.json().catch(() => ({}))) as { verified?: boolean }
  return verifyRes.ok && data.verified
    ? { ok: true }
    : { ok: false, error: 'Could not verify the passkey.' }
}

export async function loginWithPasskey(): Promise<Result> {
  const { startAuthentication } = await import('@simplewebauthn/browser')
  const optRes = await post('auth-options')
  if (!optRes.ok) return { ok: false, error: 'Could not start passkey sign-in.' }
  const optionsJSON = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON
  let assertion: unknown
  try {
    assertion = await startAuthentication({ optionsJSON })
  } catch {
    return { ok: false, error: 'Passkey sign-in was cancelled.' }
  }
  const verifyRes = await post('auth-verify', assertion)
  return verifyRes.ok
    ? { ok: true }
    : { ok: false, error: 'No matching passkey, or verification failed.' }
}
