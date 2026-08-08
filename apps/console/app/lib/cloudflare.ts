import { createContext } from 'react-router'

/**
 * The Workers bindings and `ExecutionContext`, handed to every loader/action.
 *
 * Under `future.v8_middleware` the `context` argument is a
 * `RouterContextProvider` rather than a plain object, so bindings are read with
 * `context.get(cloudflareContext)` instead of a property off `context`.
 * `workers/app.ts` is what puts the value in — it is the only writer.
 */
export const cloudflareContext = createContext<{ env: Env; ctx: ExecutionContext }>()
