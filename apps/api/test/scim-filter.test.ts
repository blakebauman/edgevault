import { describe, expect, it } from 'vitest'
import { parseUserNameFilter } from '../src/routes/scim'

/**
 * The SCIM filter parser has one job and one dangerous failure mode: if an
 * unsupported filter were treated as "no filter", the endpoint would return
 * the whole directory, the IdP would conclude the user it asked about does not
 * exist, and it would provision a duplicate. Refusing is the safe answer.
 */
describe('parseUserNameFilter', () => {
  it.each([
    ['userName eq "ada@example.com"', 'ada@example.com'],
    ['  userName   eq   "ada@example.com"  ', 'ada@example.com'], // IdPs vary on spacing
    ['USERNAME EQ "ada@example.com"', 'ada@example.com'], // attribute names are case-insensitive
    ['userName eq ""', ''],
  ])('accepts %s', (filter, expected) => {
    const parsed = parseUserNameFilter(filter)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.userName).toBe(expected)
  })

  it.each([
    'active eq true', // a different attribute
    'userName sw "ada"', // a different operator
    'userName eq "a" and active eq true', // compound
    'userName eq ada@example.com', // unquoted
    '',
  ])('refuses %s rather than falling back to everything', (filter) => {
    expect(parseUserNameFilter(filter).ok).toBe(false)
  })
})
