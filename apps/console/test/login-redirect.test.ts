import { describe, expect, it } from 'vitest'
import { loginRedirect, safeRelativePath } from '../app/lib/session.server'

/**
 * An expired session used to drop you on the workspace list regardless of how
 * deep you were. `loginRedirect` carries the destination — and must not become
 * an open redirect while doing it.
 */

function locationOf(res: Response): string | null {
  return res.headers.get('location')
}

const get = (url: string) => new Request(url, { method: 'GET' })

describe('loginRedirect', () => {
  it('remembers the path and query of a deep GET', () => {
    const res = loginRedirect(get('https://console.edgevault.io/orgs/abc/security?tab=policy'))
    expect(locationOf(res)).toBe(
      `/login?next=${encodeURIComponent('/orgs/abc/security?tab=policy')}`,
    )
  })

  it('sends a bare /login for the root, with nothing worth remembering', () => {
    expect(locationOf(loginRedirect(get('https://console.edgevault.io/')))).toBe('/login')
  })

  it('does not round-trip a POST — replaying a mutation after sign-in is worse than losing it', () => {
    const res = loginRedirect(
      new Request('https://console.edgevault.io/orgs/abc/security', { method: 'POST' }),
    )
    expect(locationOf(res)).toBe('/login')
  })

  it('drops a protocol-relative path rather than carrying it into next', () => {
    // `https://host//evil.example.com` parses to the pathname `//evil.example.com`,
    // which a browser would follow off-origin. safeRelativePath rejects it, so
    // the destination is dropped entirely instead of being echoed back.
    const res = loginRedirect(get('https://console.edgevault.io//evil.example.com'))
    expect(locationOf(res)).toBe('/login')
  })

  it('rejects off-origin destinations at the validator', () => {
    expect(safeRelativePath('//evil.example.com')).toBeNull()
    expect(safeRelativePath('https://evil.example.com')).toBeNull()
    expect(safeRelativePath('/orgs/abc')).toBe('/orgs/abc')
  })
})
