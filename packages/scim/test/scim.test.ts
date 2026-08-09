import { describe, expect, it } from 'vitest'
import { applyScimPatch, SCIM_USER_SCHEMA, type ScimUser, toScimListResponse } from '../src/index'

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

  it('rejects prototype-poisoning paths', () => {
    expect(() =>
      applyScimPatch(user(), [{ op: 'replace', path: '__proto__.polluted', value: true }]),
    ).toThrow(/unsafe/i)
    expect(() =>
      applyScimPatch(user(), [{ op: 'add', path: 'constructor.prototype.polluted', value: true }]),
    ).toThrow(/unsafe/i)
    // biome-ignore lint/suspicious/noExplicitAny: probing the global prototype
    expect(({} as any).polluted).toBeUndefined()
  })

  it('drops prototype keys from a path-less merge', () => {
    const malicious = JSON.parse('{"active": false, "__proto__": {"polluted": true}}')
    const result = applyScimPatch(user(), [{ op: 'replace', value: malicious }])
    expect(result.active).toBe(false)
    // biome-ignore lint/suspicious/noExplicitAny: probing the global prototype
    expect(({} as any).polluted).toBeUndefined()
  })
})

describe('SCIM list', () => {
  it('wraps resources in a SCIM ListResponse', () => {
    const list = toScimListResponse([user(), user()])
    expect(list.totalResults).toBe(2)
    expect(list.schemas[0]).toContain('ListResponse')
  })
})

/**
 * The exact PATCH bodies real IdPs send to deprovision.
 *
 * Okta, Entra, and OneLogin each express "deactivate this person" differently,
 * and the difference is only visible in production — a connector that silently
 * does nothing looks identical to one that works until someone audits access
 * for a leaver. These pin the shapes.
 */
describe('deprovisioning payloads from real IdPs', () => {
  const activeAfter = (ops: Parameters<typeof applyScimPatch>[1]) =>
    applyScimPatch(user(), ops).active

  it('Okta: replace with a path and a bare false', () => {
    expect(activeAfter([{ op: 'replace', path: 'active', value: false }])).toBe(false)
  })

  it('Entra: replace with no path and an object value', () => {
    expect(activeAfter([{ op: 'replace', value: { active: false } }])).toBe(false)
  })

  it('accepts the capitalised op names IdPs actually send', () => {
    expect(activeAfter([{ op: 'Replace', path: 'active', value: false }])).toBe(false)
    expect(activeAfter([{ op: 'REPLACE', value: { active: false } }])).toBe(false)
  })

  it('reactivates through the same paths', () => {
    const suspended = { ...user(), active: false }
    expect(applyScimPatch(suspended, [{ op: 'replace', path: 'active', value: true }]).active).toBe(
      true,
    )
    expect(applyScimPatch(suspended, [{ op: 'Replace', value: { active: true } }]).active).toBe(
      true,
    )
  })

  it('leaves active untouched when the patch is about something else', () => {
    // A profile-only sync must not be read as a deactivation.
    expect(activeAfter([{ op: 'replace', path: 'name.givenName', value: 'Grace' }])).toBe(true)
  })

  it('rejects a filtered path rather than guessing at it', () => {
    // Silently ignoring `emails[type eq "work"].value` would tell the IdP the
    // write succeeded when nothing changed.
    expect(() =>
      applyScimPatch(user(), [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'x' }]),
    ).toThrow(/Filtered SCIM paths/)
  })

  it('refuses prototype-poisoning paths from a hostile directory', () => {
    expect(() =>
      applyScimPatch(user(), [{ op: 'add', path: '__proto__.admin', value: true }]),
    ).toThrow(/Unsafe SCIM path/)
    const merged = applyScimPatch(user(), [
      { op: 'add', value: JSON.parse('{"__proto__": {"admin": true}}') },
    ])
    expect((merged as Record<string, unknown>).admin).toBeUndefined()
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })
})
