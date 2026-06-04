import * as jose from 'jose'
import { describe, expect, it } from 'vitest'
import {
  ENTITLEMENTS,
  EntitlementError,
  freeLicense,
  hasEntitlement,
  issueLicense,
  requireEntitlement,
  verifyLicense,
} from '../src/index'

async function keys() {
  const { privateKey, publicKey } = await jose.generateKeyPair('EdDSA', { extractable: true })
  return { priv: await jose.exportJWK(privateKey), pub: await jose.exportJWK(publicKey) }
}

describe('licensing', () => {
  it('issues and verifies an enterprise license', async () => {
    const { priv, pub } = await keys()
    const token = await issueLicense(priv, {
      organizationId: 'org-1',
      plan: 'enterprise',
      entitlements: [ENTITLEMENTS.SSO, ENTITLEMENTS.SCIM],
      expiresIn: '365d',
    })
    const license = await verifyLicense(token, pub)
    expect(license.organizationId).toBe('org-1')
    expect(license.plan).toBe('enterprise')
    expect(hasEntitlement(license, ENTITLEMENTS.SSO)).toBe(true)
    expect(hasEntitlement(license, ENTITLEMENTS.ADVANCED_RBAC)).toBe(false)
  })

  it('rejects a license signed by a different key', async () => {
    const a = await keys()
    const b = await keys()
    const token = await issueLicense(a.priv, { organizationId: 'o', plan: 'pro', entitlements: [] })
    await expect(verifyLicense(token, b.pub)).rejects.toThrow()
  })

  it('free license has no entitlements', () => {
    const license = freeLicense('org-2')
    expect(license.plan).toBe('free')
    expect(hasEntitlement(license, ENTITLEMENTS.SSO)).toBe(false)
  })

  it('requireEntitlement throws a typed error when missing', () => {
    const license = freeLicense('org-3')
    expect(() => requireEntitlement(license, ENTITLEMENTS.SCIM)).toThrow(EntitlementError)
  })
})
