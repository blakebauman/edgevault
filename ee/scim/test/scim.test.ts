import { freeLicense } from '@edgevault/licensing'
import { describe, expect, it } from 'vitest'
import {
  applyScimPatch,
  assertScimEntitled,
  SCIM_USER_SCHEMA,
  type ScimUser,
  toScimListResponse,
} from '../src/index'

const user = (): ScimUser => ({
  schemas: [SCIM_USER_SCHEMA],
  id: 'u1',
  userName: 'ada@example.com',
  name: { givenName: 'Ada' },
  active: true,
})

describe('applyScimPatch', () => {
  it('replaces a top-level attribute (deactivate)', () => {
    const result = applyScimPatch(user(), [{ op: 'replace', path: 'active', value: false }])
    expect(result.active).toBe(false)
  })

  it('adds a nested attribute', () => {
    const result = applyScimPatch(user(), [
      { op: 'add', path: 'name.familyName', value: 'Lovelace' },
    ])
    expect(result.name?.familyName).toBe('Lovelace')
    expect(result.name?.givenName).toBe('Ada') // preserved
  })

  it('removes an attribute', () => {
    const result = applyScimPatch(user(), [{ op: 'remove', path: 'name.givenName' }])
    expect(result.name?.givenName).toBeUndefined()
  })

  it('merges a path-less replace and uppercases op names (Azure-style)', () => {
    const result = applyScimPatch(user(), [{ op: 'Replace', value: { active: false } }])
    expect(result.active).toBe(false)
  })

  it('rejects filtered paths', () => {
    expect(() =>
      applyScimPatch(user(), [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'x' }]),
    ).toThrow(/not supported/)
  })

  it('does not mutate the input', () => {
    const original = user()
    applyScimPatch(original, [{ op: 'replace', path: 'active', value: false }])
    expect(original.active).toBe(true)
  })
})

describe('SCIM list + entitlement', () => {
  it('wraps resources in a SCIM ListResponse', () => {
    const list = toScimListResponse([user(), user()])
    expect(list.totalResults).toBe(2)
    expect(list.schemas[0]).toContain('ListResponse')
  })
  it('blocks SCIM without the entitlement', () => {
    expect(() => assertScimEntitled(freeLicense('org-1'))).toThrow()
  })
})
