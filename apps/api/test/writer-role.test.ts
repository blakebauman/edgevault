import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/context'
import { isWriterRole, requireWriteRole } from '../src/middleware/writer'

/**
 * Read-only enforcement for the `viewer` role.
 *
 * Before this existed the lowest role could write to every environment
 * including production, and an inventory found six workspace routes with no
 * role gate at all. The rule now lives in one middleware, so these tests are
 * the authz matrix for the whole REST subtree rather than for one handler.
 */

/** Drive the middleware through a real request for a role + method pair. */
async function attempt(role: string | null, method: string): Promise<number> {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('role', role)
    await next()
  })
  app.use('*', requireWriteRole)
  app.all('/thing', (c) => c.json({ ok: true }))
  const res = await app.request('/thing', { method })
  return res.status
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
const READ_METHODS = ['GET', 'HEAD']

describe('isWriterRole', () => {
  it.each(['owner', 'admin', 'member'])('%s can write', (role) => {
    expect(isWriterRole(role)).toBe(true)
  })

  it.each<[string | null, string]>([
    ['viewer', 'the read-only role'],
    [null, 'an unresolved role'],
    ['', 'an empty role'],
    ['Viewer', 'a differently-cased value that is not the enum'],
    ['superadmin', 'a role that does not exist'],
  ])('%s cannot write (%s)', (role) => {
    // Deny-by-default: anything that is not a known writer is refused, so a
    // future role added to the enum is read-only until someone says otherwise.
    expect(isWriterRole(role)).toBe(false)
  })
})

describe('requireWriteRole', () => {
  it.each(WRITE_METHODS)('refuses a viewer on %s', async (method) => {
    expect(await attempt('viewer', method)).toBe(403)
  })

  it.each(READ_METHODS)('lets a viewer through on %s', async (method) => {
    expect(await attempt('viewer', method)).toBe(200)
  })

  it('lets a viewer through on OPTIONS, so preflight is not mistaken for a write', async () => {
    expect(await attempt('viewer', 'OPTIONS')).toBe(200)
  })

  it.each(['owner', 'admin', 'member'])('lets %s write', async (role) => {
    for (const method of WRITE_METHODS) {
      expect(await attempt(role, method)).toBe(200)
    }
  })

  it('refuses an unresolved role rather than assuming write access', async () => {
    expect(await attempt(null, 'POST')).toBe(403)
  })

  it('answers with a code the console can act on', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('role', 'viewer')
      await next()
    })
    app.use('*', requireWriteRole)
    app.post('/thing', (c) => c.json({ ok: true }))
    const res = await app.request('/thing', { method: 'POST' })
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('read_only_role')
    // Distinguishable from a plain not-a-member 403, which is what lets the UI
    // say "you are read-only" instead of "something went wrong".
    expect(body.detail).toMatch(/read-only/i)
  })
})
