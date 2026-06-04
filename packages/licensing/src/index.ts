import * as jose from 'jose'

/**
 * Open-core entitlements. A license is a signed (EdDSA) offline token whose
 * payload lists the entitlements an org has paid for. The MIT core verifies it
 * with our public key and gates `ee/` features accordingly; the Managed Edge
 * tier sets entitlements automatically from the subscription. EE code is
 * physically isolated in `ee/` — the core only ever reads entitlement flags.
 */

const ALG = 'EdDSA'

export const ENTITLEMENTS = {
  SSO: 'sso',
  SCIM: 'scim',
  ADVANCED_RBAC: 'advanced-rbac',
  AUDIT_RETENTION: 'audit-retention',
} as const

export type Entitlement = (typeof ENTITLEMENTS)[keyof typeof ENTITLEMENTS]

export type Plan = 'free' | 'pro' | 'team' | 'enterprise'

export interface License {
  organizationId: string
  plan: Plan
  entitlements: Entitlement[]
  expiresAt: number | null
}

export interface IssueLicenseInput {
  organizationId: string
  plan: Plan
  entitlements: Entitlement[]
  /** e.g. '365d'; omit for a non-expiring license. */
  expiresIn?: string | number
}

/** Sign a license token (operator/cloud control-plane side; private key). */
export async function issueLicense(
  privateJwk: jose.JWK,
  input: IssueLicenseInput,
): Promise<string> {
  const key = (await jose.importJWK(privateJwk, ALG)) as jose.CryptoKey
  const builder = new jose.SignJWT({ plan: input.plan, entitlements: input.entitlements })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setIssuer('edgevault-licensing')
    .setSubject(input.organizationId)
  if (input.expiresIn !== undefined) builder.setExpirationTime(input.expiresIn)
  return builder.sign(key)
}

/** Verify a license token (core/self-host side; public key). Throws if invalid. */
export async function verifyLicense(token: string, publicJwk: jose.JWK): Promise<License> {
  const key = (await jose.importJWK(publicJwk, ALG)) as jose.CryptoKey
  const { payload } = await jose.jwtVerify(token, key, {
    algorithms: [ALG],
    issuer: 'edgevault-licensing',
  })
  const entitlements = Array.isArray(payload.entitlements)
    ? payload.entitlements.filter((e): e is Entitlement => typeof e === 'string')
    : []
  return {
    organizationId: String(payload.sub ?? ''),
    plan: (payload.plan as Plan) ?? 'free',
    entitlements,
    expiresAt: payload.exp ? payload.exp * 1000 : null,
  }
}

/** Free-tier entitlements (no license needed). */
export function freeLicense(organizationId: string): License {
  return { organizationId, plan: 'free', entitlements: [], expiresAt: null }
}

export function hasEntitlement(license: License, entitlement: Entitlement): boolean {
  return license.entitlements.includes(entitlement)
}

/** Throw a typed error if the entitlement is missing (use to gate ee/ features). */
export class EntitlementError extends Error {
  constructor(public readonly entitlement: Entitlement) {
    super(`This feature requires the "${entitlement}" entitlement (EdgeVault Enterprise).`)
    this.name = 'EntitlementError'
  }
}

export function requireEntitlement(license: License, entitlement: Entitlement): void {
  if (!hasEntitlement(license, entitlement)) throw new EntitlementError(entitlement)
}

export type { JWK } from 'jose'
