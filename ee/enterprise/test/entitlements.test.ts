import type { EntitlementRow } from '@edgevault/database'
import { describe, expect, it } from 'vitest'
import { rowToLicense } from '../src/entitlements'

const row = (over: Partial<EntitlementRow> = {}): EntitlementRow => ({
  plan: 'enterprise',
  entitlements: ['sso', 'scim'],
  ...over,
})

describe('rowToLicense', () => {
  it('maps a populated row into a license', () => {
    const license = rowToLicense('org-1', row())
    expect(license.plan).toBe('enterprise')
    expect(license.entitlements).toEqual(['sso', 'scim'])
    expect(license.organizationId).toBe('org-1')
  })

  it('falls back to a free license for a missing row', () => {
    const license = rowToLicense('org-1', null)
    expect(license.plan).toBe('free')
    expect(license.entitlements).toEqual([])
  })

  it('drops unknown entitlement strings so a bad row cannot grant a feature', () => {
    const license = rowToLicense('org-1', row({ entitlements: ['sso', 'totally-made-up'] }))
    expect(license.entitlements).toEqual(['sso'])
  })

  it('coerces an unknown plan to free', () => {
    const license = rowToLicense('org-1', row({ plan: 'platinum' }))
    expect(license.plan).toBe('free')
  })
})
