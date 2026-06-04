import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context'

/**
 * Per-request Drizzle client over Hyperdrive; pool closed after the response.
 *
 * `@edgevault/database` is imported dynamically so the `pg` (CommonJS) dependency
 * stays out of the worker's static module graph — that keeps the api DO/route
 * tests runnable under the Workers Vitest pool (which can't transform `pg`).
 * The dynamic chunk loads normally at runtime in workerd.
 */
export const withDatabase: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { createDatabase } = await import('@edgevault/database')
  const conn = createDatabase(c.env.HYPERDRIVE.connectionString)
  c.set('database', conn.database)
  try {
    await next()
  } finally {
    c.executionCtx.waitUntil(conn.close())
  }
}
