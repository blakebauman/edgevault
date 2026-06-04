import { ENTITLEMENTS, type License, requireEntitlement } from '@edgevault/licensing'
import * as jose from 'jose'

/**
 * EdgeVault Enterprise Edition — enterprise SSO. Phase A is OIDC (covers most
 * IdPs: Okta, Entra ID, Google Workspace) via the authorization-code + PKCE
 * flow. Phase B (SAML 2.0, XML-DSig) is the hard piece on Workers and is stubbed
 * below. This module is gated by the `sso` entitlement.
 *
 * COMMERCIAL: see ee/LICENSE. The MIT core must not import from here.
 */

/** A per-organization OIDC connection (stored encrypted; clientSecret is sensitive). */
export interface OidcConnection {
  organizationId: string
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes?: string[]
}

export interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

export interface Pkce {
  verifier: string
  challenge: string
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Generate a PKCE verifier + S256 challenge. */
export async function generatePkce(): Promise<Pkce> {
  const verifier = randomToken(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** Fetch the IdP's OpenID discovery document. */
export async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  return (await res.json()) as OidcDiscovery
}

export function buildAuthorizationUrl(
  connection: OidcConnection,
  discovery: OidcDiscovery,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', connection.clientId)
  url.searchParams.set('redirect_uri', connection.redirectUri)
  url.searchParams.set('scope', (connection.scopes ?? ['openid', 'email', 'profile']).join(' '))
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export interface OidcTokens {
  id_token: string
  access_token?: string
  refresh_token?: string
}

export async function exchangeCode(
  connection: OidcConnection,
  discovery: OidcDiscovery,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OidcTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: connection.redirectUri,
    client_id: connection.clientId,
    client_secret: connection.clientSecret,
    code_verifier: params.codeVerifier,
  })
  const res = await fetchImpl(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`)
  return (await res.json()) as OidcTokens
}

export interface IdTokenClaims {
  sub: string
  email?: string
  name?: string
  [claim: string]: unknown
}

export async function verifyIdToken(
  idToken: string,
  connection: OidcConnection,
  discovery: OidcDiscovery,
  nonce: string,
): Promise<IdTokenClaims> {
  const jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri))
  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: connection.clientId,
  })
  if (payload.nonce !== nonce) throw new Error('OIDC nonce mismatch')
  return payload as IdTokenClaims
}

/** Gate: throws EntitlementError unless the org's license includes SSO. */
export function assertSsoEntitled(license: License): void {
  requireEntitlement(license, ENTITLEMENTS.SSO)
}

/** SAML 2.0 (Phase B) — XML-DSig verification on Workers; not yet implemented. */
export function verifySamlResponse(_xml: string): never {
  throw new Error('SAML 2.0 support is not yet implemented (EE Phase B).')
}
