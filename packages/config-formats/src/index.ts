import { parse as parseIni } from 'ini'
import { load as loadYaml } from 'js-yaml'
import { parse as parseToml } from 'smol-toml'

/**
 * Multi-format configuration parsing + validation. Ported from EdgeConfig and
 * trimmed: JSON/YAML/TOML/INI parse via maintained ESM libs; Properties/CSV are
 * hand-parsed; XML is structurally validated (kept as raw text).
 */

export const CONFIG_FORMATS = [
  'json',
  'yaml',
  'xml',
  'ini',
  'toml',
  'properties',
  'csv',
  'text',
] as const

export type ConfigFormat = (typeof CONFIG_FORMATS)[number]

export interface FormatValidation {
  valid: boolean
  format: ConfigFormat
  parsed?: unknown
  error?: string
}

const EXTENSION_MAP: Record<string, ConfigFormat> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  ini: 'ini',
  toml: 'toml',
  properties: 'properties',
  props: 'properties',
  csv: 'csv',
  txt: 'text',
  text: 'text',
}

export function isConfigFormat(value: string): value is ConfigFormat {
  return (CONFIG_FORMATS as readonly string[]).includes(value)
}

/** Best-effort format detection from an optional filename, then content shape. */
export function detectFormat(content: string, filename?: string): ConfigFormat {
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop()
    if (ext && EXTENSION_MAP[ext]) return EXTENSION_MAP[ext]
  }

  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // fall through
    }
  }
  if (trimmed.startsWith('<') && trimmed.includes('>')) return 'xml'
  if (trimmed.includes('=') && !trimmed.includes('{')) return 'ini'
  if (trimmed.includes(',') && trimmed.split('\n').length > 1) return 'csv'
  if (trimmed.includes(':')) {
    try {
      loadYaml(trimmed)
      return 'yaml'
    } catch {
      // fall through
    }
  }
  return 'text'
}

/** Parse content into a structured value. Throws on malformed input. */
export function parseContent(content: string, format: ConfigFormat): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(content)
    case 'yaml':
      return loadYaml(content)
    case 'ini':
      return parseIni(content)
    case 'toml':
      return parseToml(content)
    case 'properties':
      return parseProperties(content)
    case 'csv':
      return parseCsv(content)
    default:
      return content
  }
}

/** Validate content for a format, returning the parsed value on success. */
export function validateContent(content: string, format: ConfigFormat): FormatValidation {
  if (format === 'xml') {
    const trimmed = content.trim()
    const valid = trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.includes('</')
    return valid
      ? { valid: true, format, parsed: trimmed }
      : { valid: false, format, error: 'Malformed XML' }
  }
  try {
    return { valid: true, format, parsed: parseContent(content, format) }
  } catch (error) {
    return {
      valid: false,
      format,
      error: error instanceof Error ? error.message : 'Failed to parse content',
    }
  }
}

function parseProperties(content: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid properties line: ${line}`)
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return props
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return []
  const headers = splitCsvLine(lines[0] ?? '')
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line)
    const record: Record<string, string> = {}
    headers.forEach((header, i) => {
      record[header] = values[i] ?? ''
    })
    return record
  })
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((v) => v.trim().replace(/^"(.*)"$/, '$1'))
}
