import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { CliError, type CliOptions, fetchConfig, fetchExport } from './client'
import { buildEnv, formatDotenv } from './envmap'

/**
 * `edgevault` — inject EdgeVault configs, flags, and secrets into any process.
 *
 *   edgevault run -- <cmd> [args…]   start <cmd> with the environment injected
 *   edgevault pull [--format dotenv|json]   print the environment
 *   edgevault get <key>              print one value (delivery plane, <10ms)
 *
 * Auth: EDGEVAULT_API_KEY (an environment-scoped key from the console). Keys
 * need the `secrets:read` scope for secrets to be included. Self-hosters point
 * EDGEVAULT_API_URL / EDGEVAULT_CDN_URL at their own workers.
 */

const HELP = `edgevault — EdgeVault CLI

Usage:
  edgevault run -- <cmd> [args...]
  edgevault pull [--format dotenv|json]
  edgevault get <key>

Environment:
  EDGEVAULT_API_KEY   environment-scoped API key (required)
  EDGEVAULT_API_URL   control plane   (default https://api.edgevault.io)
  EDGEVAULT_CDN_URL   delivery plane  (default https://cdn.edgevault.io)
`

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
}

function optionsFrom(io: CliIo): CliOptions {
  const apiKey = io.env.EDGEVAULT_API_KEY
  if (!apiKey) throw new CliError('EDGEVAULT_API_KEY is not set.')
  return {
    apiKey,
    apiUrl: io.env.EDGEVAULT_API_URL ?? 'https://api.edgevault.io',
    cdnUrl: io.env.EDGEVAULT_CDN_URL ?? 'https://cdn.edgevault.io',
    fetchImpl: io.fetchImpl,
  }
}

async function loadVars(io: CliIo): Promise<Record<string, string>> {
  const exported = await fetchExport(optionsFrom(io))
  const { vars, collisions } = buildEnv(exported)
  for (const collision of collisions) {
    io.stderr(`warning: env-name collision: ${collision} (later value wins)`)
  }
  if (!exported.secretsIncluded) {
    io.stderr('note: secrets omitted — the API key lacks the secrets:read scope.')
  }
  return vars
}

async function commandRun(args: string[], io: CliIo): Promise<number> {
  const split = args.indexOf('--')
  const command = split === -1 ? args : args.slice(split + 1)
  if (command.length === 0) {
    io.stderr('usage: edgevault run -- <cmd> [args...]')
    return 2
  }
  const vars = await loadVars(io)
  io.stderr(`edgevault: injected ${Object.keys(vars).length} values`)

  const doSpawn = io.spawnImpl ?? spawn
  return new Promise<number>((resolve) => {
    const child = doSpawn(command[0] as string, command.slice(1), {
      stdio: 'inherit',
      env: { ...io.env, ...vars },
    })
    child.on('error', (error) => {
      io.stderr(`edgevault: failed to start ${command[0]}: ${error.message}`)
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)))
  })
}

async function commandPull(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { format: { type: 'string', default: 'dotenv' } },
    allowPositionals: false,
  })
  const vars = await loadVars(io)
  if (values.format === 'json') io.stdout(JSON.stringify(vars, null, 2))
  else if (values.format === 'dotenv') io.stdout(formatDotenv(vars).trimEnd())
  else {
    io.stderr(`unknown --format "${values.format}" (expected dotenv|json)`)
    return 2
  }
  return 0
}

async function commandGet(args: string[], io: CliIo): Promise<number> {
  const key = args[0]
  if (!key) {
    io.stderr('usage: edgevault get <key>')
    return 2
  }
  const value = await fetchConfig(optionsFrom(io), key)
  if (!value) {
    io.stderr(`not found: ${key}`)
    return 1
  }
  io.stdout(value.content)
  return 0
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'run':
        return await commandRun(rest, io)
      case 'pull':
        return await commandPull(rest, io)
      case 'get':
        return await commandGet(rest, io)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP)
        return command === undefined ? 2 : 0
      default:
        io.stderr(`unknown command "${command}"\n\n${HELP}`)
        return 2
    }
  } catch (error) {
    io.stderr(`edgevault: ${error instanceof CliError ? error.message : String(error)}`)
    return 1
  }
}
