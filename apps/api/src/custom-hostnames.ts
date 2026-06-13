/**
 * Cloudflare for SaaS custom-hostname client for custom delivery domains
 * (ROADMAP 2.12). Org admins bring `config.acme.com` in front of the delivery
 * plane; this module owns the CF API calls plus the pure helpers (hostname
 * validation, CF→EdgeVault status mapping, vendor-error translation).
 *
 * Only active when both `CF_ZONE_ID` (var) and `CF_SAAS_API_TOKEN` (secret)
 * are configured — self-hosters on their own zone don't need any of this,
 * they just add a route to their delivery worker.
 */

export interface SaasConfig {
  zoneId: string
  apiToken: string
}

/** null = feature off (routes 404). Config-driven, not an entitlement check. */
export function saasConfig(env: Env): SaasConfig | null {
  if (!env.CF_ZONE_ID || !env.CF_SAAS_API_TOKEN) return null
  return { zoneId: env.CF_ZONE_ID, apiToken: env.CF_SAAS_API_TOKEN }
}

export type CustomDomainStatus = 'pending_dcv' | 'pending_ssl' | 'active' | 'failed'

/** CF statuses after which polling is pointless and the domain is dead. */
const TERMINAL_CF_STATUSES = new Set(['deleted', 'moved', 'blocked'])

/** Collapse CF's (hostname status, ssl status) pair into our lifecycle enum. */
export function mapCfToDomainStatus(cfStatus: string, sslStatus?: string): CustomDomainStatus {
  if (TERMINAL_CF_STATUSES.has(cfStatus)) return 'failed'
  if (cfStatus === 'active') return sslStatus && sslStatus !== 'active' ? 'pending_ssl' : 'active'
  return 'pending_dcv'
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const RESERVED_HOSTNAME =
  /^(localhost|[\d.]+|\[?[0-9a-f:]+\]?|.*\.(local|test|internal|invalid|example|onion))$/i

/**
 * Validate a customer hostname before it ever reaches the CF API.
 * Returns an error message or null. Pure — unit-tested.
 */
export function validateCustomHostname(hostname: string, platformDomain: string): string | null {
  if (hostname.length > 253) return 'Hostname is too long'
  if (hostname === platformDomain || hostname.endsWith(`.${platformDomain}`)) {
    return `${platformDomain} subdomains cannot be used as custom domains`
  }
  if (RESERVED_HOSTNAME.test(hostname)) return 'Reserved or internal hostnames cannot be used'
  if (hostname.includes('*')) return 'Wildcard hostnames are not supported'
  const labels = hostname.split('.')
  if (labels.length < 2) return 'Hostname must be a fully qualified domain name'
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return 'Hostname is not valid'
  return null
}

/**
 * Map CF API error codes to user-facing messages that don't leak the vendor.
 * Codes from the custom-hostnames API (1414 owned elsewhere, 1416/1417 DNS or
 * SSL validation, 1418 not permitted, 1420 duplicate, 1421 plan limit).
 */
export function mapCfErrors(
  errors: Array<{ code: number; message: string }> | undefined,
): string[] {
  if (!errors?.length) return ['Custom hostname operation failed']
  return errors.map((e) => {
    switch (e.code) {
      case 1414:
        return 'This hostname is already associated with another account'
      case 1416:
        return 'Hostname validation failed — ensure your DNS is configured correctly'
      case 1417:
        return 'SSL certificate provisioning failed — check your DNS and try again'
      case 1418:
        return 'Hostname is not permitted for this platform'
      case 1420:
        return 'This hostname already exists on the platform'
      case 1421:
        return 'Custom hostname limit reached'
      default:
        return 'Failed to configure custom hostname — please try again'
    }
  })
}

export interface CfDcvRecord {
  txt_name?: string
  txt_value?: string
  http_url?: string
  http_body?: string
}

export interface CfCustomHostname {
  id: string
  hostname: string
  status: string
  ssl?: {
    status: string
    validation_records?: CfDcvRecord[]
  }
  ownership_verification?: { type: string; name: string; value: string }
  ownership_verification_http?: { http_url: string; http_body: string }
}

interface CfApiResponse<T> {
  success: boolean
  result?: T
  errors?: Array<{ code: number; message: string }>
}

export type CfResult<T> = { ok: true; result: T } | { ok: false; errors: string[] }

async function cfRequest<T>(
  config: SaasConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<CfResult<T>> {
  let response: Response
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/custom_hostnames${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    )
  } catch {
    return { ok: false, errors: ['Could not reach the hostname provisioning service'] }
  }
  let json: CfApiResponse<T>
  try {
    json = (await response.json()) as CfApiResponse<T>
  } catch {
    return { ok: false, errors: [`Hostname provisioning service error (HTTP ${response.status})`] }
  }
  if (!json.success || (method !== 'DELETE' && !json.result)) {
    return { ok: false, errors: mapCfErrors(json.errors) }
  }
  return { ok: true, result: json.result as T }
}

export function createCustomHostname(
  config: SaasConfig,
  hostname: string,
): Promise<CfResult<CfCustomHostname>> {
  return cfRequest(config, 'POST', '', { hostname, ssl: { method: 'http', type: 'dv' } })
}

export function getCustomHostname(
  config: SaasConfig,
  cfHostnameId: string,
): Promise<CfResult<CfCustomHostname>> {
  return cfRequest(config, 'GET', `/${cfHostnameId}`)
}

export function deleteCustomHostname(
  config: SaasConfig,
  cfHostnameId: string,
): Promise<CfResult<unknown>> {
  return cfRequest(config, 'DELETE', `/${cfHostnameId}`)
}

/** The DCV + ownership records the console shows the customer, normalized. */
export function extractDcvRecords(cf: CfCustomHostname): Record<string, unknown> {
  return {
    ownershipVerification: cf.ownership_verification ?? null,
    ownershipVerificationHttp: cf.ownership_verification_http ?? null,
    sslValidationRecords: cf.ssl?.validation_records ?? null,
  }
}
