import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentExport } from '../src/client'
import { buildEnv, formatDotenv, toEnvName } from '../src/envmap'
import { type CliIo, main } from '../src/index'

const EXPORT: EnvironmentExport = {
  environmentId: 'env-1',
  configs: {
    'feature.timeout': { content: '{"ms":1000}', contentType: 'json', kind: 'config', version: 2 },
    HOST: { content: 'api.internal', contentType: 'text', kind: 'config', version: 1 },
  },
  secrets: { DB_PASSWORD: 'hunter2' },
  secretsIncluded: true,
}

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    for (const [suffix, make] of Object.entries(routes)) {
      if (url.includes(suffix)) return make()
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

function io(overrides: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: {
      EDGEVAULT_API_KEY: 'evk_live_test',
      EDGEVAULT_API_URL: 'https://api.test',
      EDGEVAULT_DELIVERY_URL: 'https://delivery.test',
    },
    fetchImpl: fakeFetch({
      '/machine/v1/export': () => Response.json(EXPORT),
      '/v1/configs/HOST': () => Response.json({ key: 'HOST', content: 'api.internal' }),
    }),
    ...overrides,
  }
}

describe('env mapping', () => {
  it('sanitizes keys into valid env names', () => {
    expect(toEnvName('feature.timeout')).toBe('FEATURE_TIMEOUT')
    expect(toEnvName('db-password')).toBe('DB_PASSWORD')
    expect(toEnvName('0weird')).toBe('_0WEIRD')
    expect(toEnvName('ALREADY_FINE')).toBe('ALREADY_FINE')
  })

  it('merges configs and secrets, secrets winning collisions', () => {
    const { vars, collisions } = buildEnv({
      ...EXPORT,
      configs: {
        ...EXPORT.configs,
        'db.password': { content: 'from-config', contentType: 'text', kind: 'config', version: 1 },
      },
    })
    expect(vars.FEATURE_TIMEOUT).toBe('{"ms":1000}')
    expect(vars.DB_PASSWORD).toBe('hunter2') // secret beat the config
    expect(collisions).toHaveLength(1)
  })

  it('formats dotenv with escaping', () => {
    expect(formatDotenv({ A: 'plain', B: 'line1\nline2', C: 'say "hi"' })).toBe(
      'A="plain"\nB="line1\\nline2"\nC="say \\"hi\\""\n',
    )
  })
})

describe('pull', () => {
  it('prints dotenv by default and json on request', async () => {
    const a = io()
    expect(await main(['pull'], a)).toBe(0)
    expect(a.out.join('\n')).toContain('DB_PASSWORD="hunter2"')

    const b = io()
    expect(await main(['pull', '--format', 'json'], b)).toBe(0)
    expect(JSON.parse(b.out.join('\n')).FEATURE_TIMEOUT).toBe('{"ms":1000}')
  })

  it('warns when the key cannot read secrets', async () => {
    const a = io({
      fetchImpl: fakeFetch({
        '/machine/v1/export': () =>
          Response.json({ ...EXPORT, secrets: {}, secretsIncluded: false }),
      }),
    })
    expect(await main(['pull'], a)).toBe(0)
    expect(a.err.join('\n')).toContain('secrets:read')
  })
})

describe('get', () => {
  it('prints a single value from the delivery plane', async () => {
    const a = io()
    expect(await main(['get', 'HOST'], a)).toBe(0)
    expect(a.out).toEqual(['api.internal'])
  })

  it('exits 1 for a missing key', async () => {
    const a = io()
    expect(await main(['get', 'NOPE'], a)).toBe(1)
  })
})

describe('run', () => {
  it('spawns the command with injected env and propagates the exit code', async () => {
    let spawned: { cmd: string; args: string[]; env: Record<string, string | undefined> } | null =
      null
    const spawnImpl = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      spawned = { cmd, args, env: opts.env }
      return {
        on: (event: string, cb: (code?: number | null, signal?: string | null) => void) => {
          if (event === 'exit') setTimeout(() => cb(3, null), 0)
        },
      }
    }) as unknown as CliIo['spawnImpl']

    const a = io({ spawnImpl })
    const code = await main(['run', '--', 'printenv', 'DB_PASSWORD'], a)
    expect(code).toBe(3)
    expect(spawned).not.toBeNull()
    const s = spawned as unknown as { cmd: string; args: string[]; env: Record<string, string> }
    expect(s.cmd).toBe('printenv')
    expect(s.env.DB_PASSWORD).toBe('hunter2')
    expect(s.env.FEATURE_TIMEOUT).toBe('{"ms":1000}')
    // The parent env is preserved.
    expect(s.env.EDGEVAULT_API_KEY).toBe('evk_live_test')
  })

  it('exits 2 without a command', async () => {
    expect(await main(['run'], io())).toBe(2)
  })
})

describe('errors', () => {
  it('fails clearly without an API key', async () => {
    const a = io({ env: {} })
    expect(await main(['pull'], a)).toBe(1)
    expect(a.err.join('\n')).toContain('EDGEVAULT_API_KEY')
  })

  it('maps 401 to a helpful message', async () => {
    const a = io({
      fetchImpl: fakeFetch({
        '/machine/v1/export': () => new Response('no', { status: 401 }),
      }),
    })
    expect(await main(['pull'], a)).toBe(1)
    expect(a.err.join('\n')).toContain('Unauthorized')
  })
})
