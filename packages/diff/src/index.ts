/**
 * Structural diff + content hashing for configuration values.
 * Ported and modernized from the EdgeConfig diff engine.
 */

export type ChangeType = 'added' | 'removed' | 'modified' | 'unchanged'

export interface DiffResult {
  type: ChangeType
  path: string
  oldValue?: unknown
  newValue?: unknown
}

/** SHA-256 hex digest of a value (objects are JSON-stringified). */
export async function hashContent(content: unknown): Promise<string> {
  const data = typeof content === 'string' ? content : JSON.stringify(content)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Generate a flat list of path-addressed changes between two values. */
export function generateDiff(oldValue: unknown, newValue: unknown): DiffResult[] {
  if (oldValue === newValue) return []
  if (oldValue === null || oldValue === undefined) {
    return [{ type: 'added', path: '', newValue }]
  }
  if (newValue === null || newValue === undefined) {
    return [{ type: 'removed', path: '', oldValue }]
  }
  return deepDiff(oldValue, newValue, '')
}

/** One-line human summary, e.g. "2 added, 1 removed, 3 modified". */
export function summarizeDiff(diff: DiffResult[]): string {
  const counts = { added: 0, removed: 0, modified: 0 }
  for (const d of diff) {
    if (d.type === 'added') counts.added++
    else if (d.type === 'removed') counts.removed++
    else if (d.type === 'modified') counts.modified++
  }
  const parts: string[] = []
  if (counts.added) parts.push(`${counts.added} added`)
  if (counts.removed) parts.push(`${counts.removed} removed`)
  if (counts.modified) parts.push(`${counts.modified} modified`)
  return parts.length ? parts.join(', ') : 'No changes'
}

function deepDiff(oldValue: unknown, newValue: unknown, path: string): DiffResult[] {
  if (typeof oldValue !== typeof newValue) {
    return [{ type: 'modified', path, oldValue, newValue }]
  }

  if (typeof oldValue !== 'object' || oldValue === null || newValue === null) {
    return oldValue === newValue ? [] : [{ type: 'modified', path, oldValue, newValue }]
  }

  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    return diffArrays(oldValue, newValue, path)
  }

  return diffObjects(oldValue as Record<string, unknown>, newValue as Record<string, unknown>, path)
}

function diffArrays(oldArray: unknown[], newArray: unknown[], path: string): DiffResult[] {
  const diffs: DiffResult[] = []
  const max = Math.max(oldArray.length, newArray.length)
  for (let i = 0; i < max; i++) {
    const childPath = `${path}[${i}]`
    if (i >= oldArray.length) diffs.push({ type: 'added', path: childPath, newValue: newArray[i] })
    else if (i >= newArray.length)
      diffs.push({ type: 'removed', path: childPath, oldValue: oldArray[i] })
    else diffs.push(...deepDiff(oldArray[i], newArray[i], childPath))
  }
  return diffs
}

function diffObjects(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  path: string,
): DiffResult[] {
  const diffs: DiffResult[] = []
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key
    if (!(key in oldObj)) diffs.push({ type: 'added', path: childPath, newValue: newObj[key] })
    else if (!(key in newObj))
      diffs.push({ type: 'removed', path: childPath, oldValue: oldObj[key] })
    else diffs.push(...deepDiff(oldObj[key], newObj[key], childPath))
  }
  return diffs
}
