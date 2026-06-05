import { describe, expect, it } from 'vitest'
import { type ConfigRef, extractRefs, hasRefs, RefError, resolveRefs } from '../src/index'

describe('extractRefs', () => {
  it('finds same-env and cross-env references', () => {
    const refs = extractRefs('host=${API_HOST} port=${prod/API_PORT}')
    expect(refs).toEqual([
      { envSlug: null, key: 'API_HOST', raw: '${API_HOST}' },
      { envSlug: 'prod', key: 'API_PORT', raw: '${prod/API_PORT}' },
    ])
  })

  it('dedupes repeated references and allows dots/dashes/underscores', () => {
    const refs = extractRefs('${a.b-c_d} ${a.b-c_d} ${x}')
    expect(refs).toHaveLength(2)
  })

  it('ignores malformed placeholders', () => {
    expect(extractRefs('${} ${a b} ${a/b/c} $KEY {KEY}')).toEqual([])
    expect(hasRefs('plain text')).toBe(false)
    expect(hasRefs('${K}')).toBe(true)
  })
})

/** Test double: environments are plain string ids, items keyed by `env/KEY`. */
function makeDeref(graph: Record<string, string>) {
  return (ref: ConfigRef, env: string) => {
    const targetEnv = ref.envSlug ?? env
    const id = `${targetEnv}/${ref.key}`
    const content = graph[id]
    return content === undefined ? null : { id, content, ctx: targetEnv }
  }
}

describe('resolveRefs', () => {
  const deref = makeDeref({
    'dev/HOST': 'api.internal',
    'dev/PORT': '8080',
    'dev/URL': 'https://${HOST}:${PORT}/v1',
    'dev/GREETING': 'hello',
    'prod/HOST': 'api.example.com',
    'prod/URL': 'https://${HOST}/v1',
  })

  it('substitutes plain references textually', () => {
    expect(resolveRefs('url=${HOST}', 'dev/X', 'dev', deref)).toBe('url=api.internal')
  })

  it('resolves nested references recursively', () => {
    expect(resolveRefs('${URL}', 'dev/X', 'dev', deref)).toBe('https://api.internal:8080/v1')
  })

  it('resolves cross-environment references', () => {
    expect(resolveRefs('${prod/HOST}', 'dev/X', 'dev', deref)).toBe('api.example.com')
  })

  it('resolves slug-less refs inside a cross-env target in the TARGET environment', () => {
    // prod/URL contains ${HOST}, which must mean prod/HOST — not dev/HOST.
    expect(resolveRefs('${prod/URL}', 'dev/X', 'dev', deref)).toBe('https://api.example.com/v1')
  })

  it('leaves content without references untouched', () => {
    expect(resolveRefs('no refs here', 'dev/X', 'dev', deref)).toBe('no refs here')
  })

  it('throws on unknown references', () => {
    try {
      resolveRefs('${MISSING}', 'dev/X', 'dev', deref)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RefError)
      expect((error as RefError).code).toBe('unknown')
    }
  })

  it('detects direct and transitive cycles', () => {
    const cyclic = makeDeref({
      'dev/A': '${B}',
      'dev/B': '${C}',
      'dev/C': '${A}',
      'dev/SELF': '${SELF}',
    })
    expect(() => resolveRefs('${B}', 'dev/A', 'dev', cyclic)).toThrowError(/circular/)
    expect(() => resolveRefs('${SELF}', 'dev/SELF', 'dev', cyclic)).toThrowError(/circular/)
    // Resolving from an item OUTSIDE the cycle still detects it.
    try {
      resolveRefs('${A}', 'dev/X', 'dev', cyclic)
      expect.unreachable()
    } catch (error) {
      expect((error as RefError).code).toBe('cycle')
    }
  })

  it('enforces the depth cap on deep (non-cyclic) chains', () => {
    const deep: Record<string, string> = {}
    for (let i = 0; i < 20; i++) deep[`dev/L${i}`] = `\${L${i + 1}}`
    deep['dev/L20'] = 'bottom'
    try {
      resolveRefs('${L0}', 'dev/START', 'dev', makeDeref(deep))
      expect.unreachable()
    } catch (error) {
      expect((error as RefError).code).toBe('depth')
    }
  })

  it('resolves multiple references in one string', () => {
    expect(resolveRefs('${GREETING} from ${HOST}', 'dev/X', 'dev', deref)).toBe(
      'hello from api.internal',
    )
  })

  it('allows the same item to appear twice on DIFFERENT branches (diamond, not cycle)', () => {
    const diamond = makeDeref({
      'dev/BASE': 'b',
      'dev/LEFT': '${BASE}-l',
      'dev/RIGHT': '${BASE}-r',
    })
    expect(resolveRefs('${LEFT} ${RIGHT}', 'dev/TOP', 'dev', diamond)).toBe('b-l b-r')
  })
})
