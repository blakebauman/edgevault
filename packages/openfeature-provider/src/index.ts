/**
 * @edgevault/openfeature-provider — an OpenFeature provider backed by the
 * EdgeVault delivery (edge read) plane.
 *
 * Lets a team keep their OpenFeature evaluation code and choose EdgeVault as the
 * provider. Resolution is delegated to `@edgevault/sdk`, which reads pre-resolved
 * values from the edge — targeting/rollout is already applied server-side at
 * write time, so the evaluation context is not forwarded (this is a `server`
 * provider with a static, per-environment view).
 *
 *   import { OpenFeature } from '@openfeature/server-sdk'
 *   import { EdgeVaultProvider } from '@edgevault/openfeature-provider'
 *
 *   await OpenFeature.setProviderAndWait(
 *     new EdgeVaultProvider({ apiKey: process.env.EDGEVAULT_API_KEY! }),
 *   )
 *   const client = OpenFeature.getClient()
 *   const on = await client.getBooleanValue('feature.search.enabled', false)
 *
 * Type → EdgeVault route mapping (the delivery plane is split by kind):
 * - `getBooleanValue` → feature **flags** (`/v1/flags/{key}`)
 * - `getString` / `getNumber` / `getObject` → **configs** (`/v1/configs/{key}`)
 */

import type { ConfigRecord, EdgeVaultOptions } from '@edgevault/sdk'
import { EdgeVault } from '@edgevault/sdk'
import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/server-sdk'
import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk'

/** Either delivery-client options, or an already-constructed client to reuse. */
export type EdgeVaultProviderOptions =
  | EdgeVaultOptions
  | {
      /** A pre-built EdgeVault client (e.g. shared with non-flag reads). */
      client: EdgeVault
    }

/** Which delivery route a flag key resolves through. */
type Route = 'flags' | 'configs'

/** A successful coercion to `T`, or a signal that the stored value is the wrong type. */
type Coerced<T> = { ok: true; value: T } | { ok: false }

export class EdgeVaultProvider implements Provider {
  readonly metadata: ProviderMetadata = { name: 'edgevault-provider' }
  readonly runsOn = 'server' as const

  readonly #client: EdgeVault

  constructor(options: EdgeVaultProviderOptions) {
    this.#client = 'client' in options ? options.client : new EdgeVault(options)
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    _context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    return this.#resolve('flags', flagKey, defaultValue, coerceBoolean, logger)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    _context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return this.#resolve('configs', flagKey, defaultValue, coerceString, logger)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    _context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return this.#resolve('configs', flagKey, defaultValue, coerceNumber, logger)
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    return this.#resolve('configs', flagKey, defaultValue, coerceJson<T>, logger)
  }

  /** Drop the underlying client's in-process cache on shutdown. */
  async onClose(): Promise<void> {
    this.#client.clearCache()
  }

  async #resolve<T>(
    route: Route,
    flagKey: string,
    defaultValue: T,
    coerce: (rec: ConfigRecord) => Coerced<T>,
    logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    let rec: ConfigRecord | null
    try {
      rec =
        route === 'flags'
          ? await this.#client.flagRecord(flagKey)
          : await this.#client.config(flagKey)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`[edgevault] resolving "${flagKey}" failed: ${errorMessage}`)
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.GENERAL,
        errorMessage,
      }
    }

    if (!rec) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.FLAG_NOT_FOUND,
        errorMessage: `flag "${flagKey}" not found`,
      }
    }

    const coerced = coerce(rec)
    if (!coerced.ok) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TYPE_MISMATCH,
        errorMessage: `flag "${flagKey}" is not a ${typeof defaultValue}`,
      }
    }

    // The edge serves a pre-resolved value — targeting is already applied, so
    // from the provider's vantage point the result is STATIC for this environment.
    return {
      value: coerced.value,
      reason: StandardResolutionReasons.STATIC,
      flagMetadata: { version: rec.version, edgevaultKind: rec.kind },
    }
  }
}

// --- coercion: delivery returns string content; map it to the requested type ---

function coerceBoolean(rec: ConfigRecord): Coerced<boolean> {
  const t = rec.content.trim().toLowerCase()
  if (t === 'true' || t === '1' || t === 'on' || t === 'yes') return { ok: true, value: true }
  if (t === 'false' || t === '0' || t === 'off' || t === 'no' || t === '')
    return { ok: true, value: false }
  try {
    const j = JSON.parse(rec.content) as unknown
    if (typeof j === 'boolean') return { ok: true, value: j }
    if (j && typeof j === 'object' && typeof (j as { enabled?: unknown }).enabled === 'boolean') {
      return { ok: true, value: (j as { enabled: boolean }).enabled }
    }
  } catch {
    // not JSON
  }
  return { ok: false }
}

function coerceString(rec: ConfigRecord): Coerced<string> {
  // A JSON-encoded string ("hello") unwraps to its value; anything else is raw.
  if (/json/i.test(rec.contentType)) {
    try {
      const j = JSON.parse(rec.content) as unknown
      if (typeof j === 'string') return { ok: true, value: j }
    } catch {
      // fall through to raw content
    }
  }
  return { ok: true, value: rec.content }
}

function coerceNumber(rec: ConfigRecord): Coerced<number> {
  if (/json/i.test(rec.contentType)) {
    try {
      const j = JSON.parse(rec.content) as unknown
      if (typeof j === 'number' && Number.isFinite(j)) return { ok: true, value: j }
    } catch {
      // fall through to a plain numeric parse
    }
  }
  const trimmed = rec.content.trim()
  if (trimmed !== '') {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return { ok: true, value: n }
  }
  return { ok: false }
}

function coerceJson<T extends JsonValue>(rec: ConfigRecord): Coerced<T> {
  try {
    return { ok: true, value: JSON.parse(rec.content) as T }
  } catch {
    return { ok: false }
  }
}
