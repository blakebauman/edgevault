/**
 * Config reference syntax: `${KEY}` interpolates another item from the same
 * environment, `${env-slug/KEY}` from a sibling environment in the same
 * workspace. Resolution is textual (the referenced item's *resolved* content is
 * substituted as-is) and recursive with cycle/depth protection. Secrets can
 * neither be referenced nor contain references — enforced by the caller, which
 * owns item kinds; this package is pure string/graph logic.
 */

export interface ConfigRef {
  /** Environment slug, or null for "same environment as the referencing item". */
  envSlug: string | null
  key: string
  /** The exact placeholder as written, e.g. `${prod/API_URL}`. */
  raw: string
}

/** `${KEY}` or `${env-slug/KEY}` — key and slug share the config-key charset. */
const REF_PATTERN = /\$\{([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)\}/g

export const MAX_REF_DEPTH = 10

/** Unique references appearing in a content string, in order of appearance. */
export function extractRefs(content: string): ConfigRef[] {
  const refs = new Map<string, ConfigRef>()
  for (const match of content.matchAll(REF_PATTERN)) {
    const inner = match[1] as string
    if (refs.has(inner)) continue
    const slash = inner.indexOf('/')
    refs.set(inner, {
      envSlug: slash === -1 ? null : inner.slice(0, slash),
      key: slash === -1 ? inner : inner.slice(slash + 1),
      raw: match[0],
    })
  }
  return [...refs.values()]
}

export function hasRefs(content: string): boolean {
  REF_PATTERN.lastIndex = 0
  return REF_PATTERN.test(content)
}

export class RefError extends Error {
  constructor(
    readonly code: 'unknown' | 'cycle' | 'depth',
    readonly ref: string,
    message: string,
  ) {
    super(message)
    this.name = 'RefError'
  }
}

/**
 * Resolve a reference relative to the environment context `ctx` (an opaque
 * caller value, e.g. the environment id the *referencing* content lives in).
 * Returns the target's stable identity (for cycle detection), its RAW content
 * (which may itself contain references), and the context its own references
 * resolve in — slug-less refs inside a cross-environment target must resolve
 * in the TARGET's environment, not the original one.
 *
 * Return null when the target is missing or not referenceable (unknown
 * environment, unknown key, secret kind).
 */
export type RefDeref<C> = (ref: ConfigRef, ctx: C) => { id: string; content: string; ctx: C } | null

/**
 * Recursively resolve every reference in `content`. `id` identifies the item
 * being resolved so self-cycles are caught.
 *
 * Throws RefError on unknown references, cycles, or depth overflow — write
 * paths surface these as validation failures, so a bad graph can never be
 * persisted, and read paths can therefore trust resolution to succeed.
 */
export function resolveRefs<C>(content: string, id: string, ctx: C, deref: RefDeref<C>): string {
  return resolve(content, ctx, deref, [id])
}

function resolve<C>(content: string, ctx: C, deref: RefDeref<C>, stack: string[]): string {
  if (stack.length > MAX_REF_DEPTH) {
    throw new RefError('depth', stack[stack.length - 1] as string, 'reference depth exceeded')
  }
  return content.replace(REF_PATTERN, (raw, inner: string) => {
    const slash = inner.indexOf('/')
    const ref: ConfigRef = {
      envSlug: slash === -1 ? null : inner.slice(0, slash),
      key: slash === -1 ? inner : inner.slice(slash + 1),
      raw,
    }
    const target = deref(ref, ctx)
    if (target === null) {
      throw new RefError('unknown', raw, `unknown reference ${raw}`)
    }
    if (stack.includes(target.id)) {
      throw new RefError('cycle', raw, `circular reference: ${[...stack, target.id].join(' → ')}`)
    }
    return resolve(target.content, target.ctx, deref, [...stack, target.id])
  })
}
