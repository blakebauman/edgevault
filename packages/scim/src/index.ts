/**
 * SCIM 2.0 directory provisioning (RFC 7643/7644). Provides the resource shapes
 * and the PATCH operation applier; the HTTP endpoints mount in the api worker.
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

// IdP-supplied attribute paths must never reach Object.prototype: a segment
// like `__proto__`, `constructor`, or `prototype` would let a SCIM PATCH walk
// out of the resource and pollute the prototype chain (the `typeof === object`
// guards below pass for `__proto__`). Reject those segments outright.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafePath(path: string): string[] {
  const segments = path.split('.')
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new Error(`Unsafe SCIM path segment: ${segment}`)
    }
  }
  return segments
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = assertSafePath(path)
  let node = target
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i] as string
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[segments[segments.length - 1] as string] = value
}

function removePath(target: Record<string, unknown>, path: string): void {
  const segments = assertSafePath(path)
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
        // Path-less merge: copy own keys but skip the prototype-poisoning ones
        // (a `__proto__` own-key would retarget result's prototype via [[Set]]).
        for (const [key, val] of Object.entries(operation.value)) {
          if (!FORBIDDEN_SEGMENTS.has(key)) result[key as keyof T] = val as T[keyof T]
        }
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
