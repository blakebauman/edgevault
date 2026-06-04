import { describe, expect, it } from 'vitest'
import { generateDiff, hashContent, summarizeDiff } from '../src/index'

describe('generateDiff', () => {
  it('detects added, removed, and modified keys', () => {
    const diff = generateDiff({ a: 1, b: 2, nested: { x: 1 } }, { a: 1, c: 3, nested: { x: 2 } })
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d.type]))
    expect(byPath.b).toBe('removed')
    expect(byPath.c).toBe('added')
    expect(byPath['nested.x']).toBe('modified')
    expect(byPath.a).toBeUndefined() // unchanged keys are omitted
  })

  it('returns empty for identical values', () => {
    expect(generateDiff({ a: [1, 2] }, { a: [1, 2] })).toEqual([])
  })

  it('handles array index changes', () => {
    const diff = generateDiff([1, 2], [1, 2, 3])
    expect(diff).toEqual([{ type: 'added', path: '[2]', newValue: 3 }])
  })
})

describe('summarizeDiff', () => {
  it('summarizes counts', () => {
    const diff = generateDiff({ a: 1, b: 2 }, { a: 9, c: 3 })
    expect(summarizeDiff(diff)).toBe('1 added, 1 removed, 1 modified')
  })

  it('reports no changes', () => {
    expect(summarizeDiff([])).toBe('No changes')
  })
})

describe('hashContent', () => {
  it('is stable and order-independent for strings', async () => {
    expect(await hashContent('hello')).toBe(await hashContent('hello'))
    expect(await hashContent({ a: 1 })).toHaveLength(64)
  })

  it('differs for different content', async () => {
    expect(await hashContent({ a: 1 })).not.toBe(await hashContent({ a: 2 }))
  })
})
