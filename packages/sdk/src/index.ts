/**
 * @edgevault/sdk — typed client for the EdgeVault delivery (edge read) plane.
 *
 * Reads pre-resolved configs and feature flags from the edge with an optional
 * short-lived in-process cache (mirroring the worker's L1). Runs anywhere the
 * Fetch API is available: browsers, Node 18+, Cloudflare Workers, Deno, Bun.
 *
 *   const ev = new EdgeVault({ apiKey: process.env.EDGEVAULT_API_KEY! })
 *   const theme = await ev.value<string>('feature.checkout.theme')
 *   if (await ev.flag('feature.search.enabled')) { ... }
 *   const many = await ev.batch(['a', 'b', 'c'])
 */
import type { ResolvedConfig } from '@edgevault/edge-protocol'

export type { ResolvedConfig }

/** A resolved config/flag plus its key, as returned by the single-key routes. */
export type ConfigRecord = ResolvedConfig & { key: string }

export interface EdgeVaultOptions {
  /** Environment-scoped API key (shown once at creation). Required. */
  apiKey: string
  /** Delivery base URL. Default: `https://cdn.edgevault.io`. */
  baseUrl?: string
  /** In-process cache TTL in ms (caches hits and misses). 0 disables. Default 15000. */
  cacheTtlMs?: number
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number
  /** Fetch implementation. Defaults to the global `fetch`. Inject for tests. */
  fetch?: typeof fetch
}

/** Any non-success response from the delivery plane. */
export class EdgeVaultError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'EdgeVaultError'
    this.status = status
    this.code = code
  }
}

/** A 401 — the API key is missing, invalid, or not scoped to this environment. */
export class EdgeVaultAuthError extends EdgeVaultError {
  constructor(message = 'unauthorized') {
    super(message, 401, 'unauthorized')
    this.name = 'EdgeVaultAuthError'
  }
}

const DEFAULT_BASE = 'https://cdn.edgevault.io'

type CacheEntry = { value: ConfigRecord | null; expires: number }

export class EdgeVault {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #cacheTtlMs: number
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch
  readonly #cache = new Map<string, CacheEntry>()

  constructor(options: EdgeVaultOptions) {
    if (!options?.apiKey) throw new EdgeVaultError('apiKey is required', 0, 'config')
    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
    this.#cacheTtlMs = options.cacheTtlMs ?? 15_000
    this.#timeoutMs = options.timeoutMs ?? 5_000
    const f = options.fetch ?? globalThis.fetch
    if (!f) throw new EdgeVaultError('no fetch implementation available', 0, 'config')
    this.#fetch = f.bind(globalThis)
  }

  /** Fetch a single config record, or `null` if it does not exist (404). */
  async config(key: string): Promise<ConfigRecord | null> {
    return this.#getRecord('configs', key)
  }

  /** Fetch a flag record, or `null` if it does not exist (404). */
  async flagRecord(key: string): Promise<ConfigRecord | null> {
    return this.#getRecord('flags', key)
  }

  /**
   * The config's value. JSON content (`contentType` containing `json`) is parsed
   * as `T`; anything else is returned as the raw string. `null` if not found.
   */
  async value<T = string>(key: string): Promise<T | null> {
    const rec = await this.config(key)
    if (!rec) return null
    return decode<T>(rec)
  }

  /**
   * Evaluate a feature flag as a boolean. Recognises `true/false`, `1/0`,
   * `on/off`, `yes/no` (case-insensitive), a JSON boolean, or a JSON object with
   * a boolean `enabled` field. Anything unrecognised — including a missing flag
   * — returns `fallback` (default `false`).
   */
  async flag(key: string, fallback = false): Promise<boolean> {
    const rec = await this.flagRecord(key)
    if (!rec) return fallback
    return coerceBool(rec.content, fallback)
  }

  /**
   * Fetch many keys in one request. Returns a map of key → record (or `null`
   * for keys with no value). Populates the per-key cache.
   */
  async batch(keys: string[]): Promise<Record<string, ConfigRecord | null>> {
    const out: Record<string, ConfigRecord | null> = {}
    if (keys.length === 0) return out
    const body = await this.#request('POST', '/v1/batch', { keys })
    const configs = (body?.configs ?? {}) as Record<string, ResolvedConfig | null>
    for (const key of keys) {
      const value = configs[key] ?? null
      const rec = value ? { key, ...value } : null
      out[key] = rec
      this.#cacheSet(this.#path('configs', key), rec)
    }
    return out
  }

  /** Drop the in-process cache (e.g. after a known config change). */
  clearCache(): void {
    this.#cache.clear()
  }

  #path(kind: 'configs' | 'flags', key: string): string {
    return `/v1/${kind}/${encodeURIComponent(key)}`
  }

  async #getRecord(kind: 'configs' | 'flags', key: string): Promise<ConfigRecord | null> {
    const path = this.#path(kind, key)
    const cached = this.#cacheGet(path)
    if (cached) return cached.value
    const body = await this.#request('GET', path)
    const rec = body === null ? null : (body as ConfigRecord)
    this.#cacheSet(path, rec)
    return rec
  }

  #cacheGet(path: string): CacheEntry | undefined {
    if (this.#cacheTtlMs <= 0) return undefined
    const hit = this.#cache.get(path)
    if (!hit) return undefined
    if (hit.expires < Date.now()) {
      this.#cache.delete(path)
      return undefined
    }
    return hit
  }

  #cacheSet(path: string, value: ConfigRecord | null): void {
    if (this.#cacheTtlMs <= 0) return
    this.#cache.set(path, { value, expires: Date.now() + this.#cacheTtlMs })
  }

  /**
   * Issue a request. Returns the parsed JSON body, or `null` on 404. Throws
   * `EdgeVaultAuthError` on 401 and `EdgeVaultError` on any other failure.
   */
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are route-specific
  async #request(method: string, path: string, json?: unknown): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let res: Response
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new EdgeVaultError(
        aborted ? `request timed out after ${this.#timeoutMs}ms` : `network error: ${String(err)}`,
        0,
        aborted ? 'timeout' : 'network',
      )
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 404) return null
    if (res.status === 401) throw new EdgeVaultAuthError()
    if (!res.ok) {
      const code = await res
        .clone()
        .json()
        .then((b) => (b as { error?: string }).error)
        .catch(() => undefined)
      throw new EdgeVaultError(`request failed (${res.status})`, res.status, code ?? 'http_error')
    }
    return res.json()
  }
}

function decode<T>(rec: ConfigRecord): T {
  if (/json/i.test(rec.contentType)) {
    try {
      return JSON.parse(rec.content) as T
    } catch {
      // fall through to the raw string for malformed JSON
    }
  }
  return rec.content as unknown as T
}

function coerceBool(content: string, fallback: boolean): boolean {
  const t = content.trim().toLowerCase()
  if (t === 'true' || t === '1' || t === 'on' || t === 'yes') return true
  if (t === 'false' || t === '0' || t === 'off' || t === 'no' || t === '') return false
  try {
    const j = JSON.parse(content) as unknown
    if (typeof j === 'boolean') return j
    if (j && typeof j === 'object' && typeof (j as { enabled?: unknown }).enabled === 'boolean') {
      return (j as { enabled: boolean }).enabled
    }
  } catch {
    // not JSON
  }
  return fallback
}
