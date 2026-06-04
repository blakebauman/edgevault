import { describe, expect, it } from 'vitest'
import { detectFormat, parseContent, validateContent } from '../src/index'

describe('detectFormat', () => {
  it('uses the filename extension when available', () => {
    expect(detectFormat('whatever', 'app.yaml')).toBe('yaml')
    expect(detectFormat('whatever', 'data.toml')).toBe('toml')
  })

  it('falls back to content shape', () => {
    expect(detectFormat('{"a":1}')).toBe('json')
    expect(detectFormat('<root><a>1</a></root>')).toBe('xml')
    expect(detectFormat('a,b\n1,2')).toBe('csv')
  })
})

describe('parseContent / validateContent', () => {
  it('parses JSON', () => {
    expect(parseContent('{"a":1}', 'json')).toEqual({ a: 1 })
  })

  it('parses YAML', () => {
    expect(parseContent('a: 1\nb: two', 'yaml')).toEqual({ a: 1, b: 'two' })
  })

  it('parses TOML', () => {
    expect(parseContent('[server]\nport = 8080', 'toml')).toEqual({ server: { port: 8080 } })
  })

  it('parses INI', () => {
    expect(parseContent('[s]\nk=v', 'ini')).toEqual({ s: { k: 'v' } })
  })

  it('parses Properties', () => {
    expect(parseContent('a.b=1\n# c\nd=two', 'properties')).toEqual({ 'a.b': '1', d: 'two' })
  })

  it('parses CSV with headers', () => {
    expect(parseContent('name,age\nAda,36', 'csv')).toEqual([{ name: 'Ada', age: '36' }])
  })

  it('validates malformed JSON as invalid', () => {
    const result = validateContent('{not json', 'json')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('validates well-formed XML structurally', () => {
    expect(validateContent('<a>1</a>', 'xml').valid).toBe(true)
    expect(validateContent('not xml', 'xml').valid).toBe(false)
  })
})
