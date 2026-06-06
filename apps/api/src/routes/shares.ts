import { generateToken } from '@edgevault/auth'
import { zValidator } from '@hono/zod-validator'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import { rateLimitByIp } from '../rate-limit'
import { timingSafeEqual } from '../timing'

/**
 * Zero-knowledge share links. Creation is a normal authenticated API call; the
 * body is CIPHERTEXT only (the AES key lives in the URL fragment and never
 * reaches any server). Consumption is unauthenticated for the recipient, so it
 * is exposed only to the console BFF behind the shared INTERNAL_TOKEN — the
 * public api hostname never serves share content directly.
 */

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const MAX_CIPHERTEXT_BYTES = 64 * 1024

const createShareSchema = z.object({
  ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
  iv: z.string().min(1).max(64),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_TTL_SECONDS)
    .default(24 * 60 * 60),
  maxViews: z.number().int().min(1).max(10).default(1),
})

/** Authenticated creation surface (mounted under /api/v1/shares). */
export const shareRoutes = new Hono<AppEnv>().post(
  '/',
  zValidator('json', createShareSchema),
  async (c) => {
    const body = c.req.valid('json')
    // 128-bit random id: the link is a capability, so the id must be unguessable.
    const id = generateToken(16)
    const expiresAt = Date.now() + body.ttlSeconds * 1000
    await c.env.SHARE.get(c.env.SHARE.idFromName(id)).create({
      ciphertext: body.ciphertext,
      iv: body.iv,
      expiresAt,
      maxViews: body.maxViews,
      createdBy: c.var.userId,
    })
    return c.json({ id, expiresAt, maxViews: body.maxViews }, 201)
  },
)

// Recipients are anonymous, so the console BFF performs the consume on their
// behalf; the shared INTERNAL_TOKEN keeps this endpoint from being driven
// directly by the public even though it shares the api's fetch handler.
const requireInternalToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqual(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

/** Internal consume surface (mounted under /internal/shares). */
export const internalShareRoutes = new Hono<AppEnv>()
  // Share ids are capabilities — cap online guessing before the token check.
  .use(
    '*',
    rateLimitByIp((env) => env.SHARE_IP_LIMITER, 'share-consume'),
  )
  .use('*', requireInternalToken)
  .post('/:id/consume', async (c) => {
    const id = c.req.param('id')
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return c.json({ error: 'gone' }, 410)
    const result = await c.env.SHARE.get(c.env.SHARE.idFromName(id)).consume()
    if (!result.ok) return c.json({ error: 'gone' }, 410)
    return c.json({
      ciphertext: result.ciphertext,
      iv: result.iv,
      remainingViews: result.remainingViews,
    })
  })
