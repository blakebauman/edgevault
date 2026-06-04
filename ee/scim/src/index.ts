import { ENTITLEMENTS, type License, requireEntitlement } from '@edgevault/licensing'

/**
 * EdgeVault Enterprise Edition — SCIM 2.0 directory provisioning (RFC 7643/7644).
 * Provides the resource shapes and the PATCH operation applier; the HTTP
 * endpoints mount in the auth worker, gated by the `scim` entitlement.
 *
 * COMMERCIAL: see ee/LICENSE. The MIT core must not import from here.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'

export interface ScimName {
  givenName?: string
  familyName?: string
  formatted?: string
}

export interface ScimEmail {
  value: string
  type?: string
  primary?: boolean
}

export interface ScimUser {
  schemas: string[]
  id?: string
  userName: string
  name?: ScimName
  emails?: ScimEmail[]
  active?: boolean
  [attribute: string]: unknown
}

export type ScimPatchOpName = 'add' | 'replace' | 'remove'

export interface ScimPatchOperation {
  /** Case-insensitive; IdPs send "add"/"Replace"/"REMOVE" etc. */
  op: string
  path?: string
  value?: unknown
}

export interface ScimPatchRequest {
  schemas: string[]
  Operations: ScimPatchOperation[]
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let node = target
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i] as string
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[segments[segments.length - 1] as string] = value
}

function removePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.')
  let node = target
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i] as string]
    if (typeof next !== 'object' || next === null) return
    node = next as Record<string, unknown>
  }
  delete node[segments[segments.length - 1] as string]
}

/**
 * Apply SCIM PATCH operations to a resource, returning a new object. Supports
 * dotted attribute paths and path-less `add`/`replace` (merge). Filtered paths
 * (e.g. `emails[type eq "work"].value`) are not yet supported.
 */
export function applyScimPatch<T extends Record<string, unknown>>(
  resource: T,
  operations: ScimPatchOperation[],
): T {
  const result = structuredClone(resource)
  for (const operation of operations) {
    const op = operation.op.toLowerCase() as ScimPatchOpName
    if (operation.path?.includes('[')) {
      throw new Error(`Filtered SCIM paths are not supported: ${operation.path}`)
    }
    if (op === 'remove') {
      if (operation.path) removePath(result, operation.path)
    } else if (op === 'add' || op === 'replace') {
      if (operation.path) {
        setPath(result, operation.path, operation.value)
      } else if (operation.value && typeof operation.value === 'object') {
        Object.assign(result, operation.value)
      }
    }
  }
  return result
}

export function toScimListResponse<T>(
  resources: T[],
  startIndex = 1,
): {
  schemas: string[]
  totalResults: number
  startIndex: number
  itemsPerPage: number
  Resources: T[]
} {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  }
}

/** Gate: throws EntitlementError unless the org's license includes SCIM. */
export function assertScimEntitled(license: License): void {
  requireEntitlement(license, ENTITLEMENTS.SCIM)
}
