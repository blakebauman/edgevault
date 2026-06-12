/**
 * Thin HTTP clients for the two EdgeVault planes, authenticated by an
 * environment-scoped API key. `run`/`pull` use the api machine export (the only
 * surface that can include secrets — gated by the key's `secrets:read` scope);
 * `get` uses the delivery plane, the <10ms read path.
 */

export interface CliOptions {
  apiKey: string
  apiUrl: string
  deliveryUrl: string
  fetchImpl?: typeof fetch
}

export interface ResolvedConfigValue {
  content: string
  contentType: string
  kind: 'config' | 'flag'
  version: number
}

export interface EnvironmentExport {
  environmentId: string
  configs: Record<string, ResolvedConfigValue>
  secrets: Record<string, string>
  secretsIncluded: boolean
}

export class CliError extends Error {}

async function request(options: CliOptions, base: string, path: string): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(`${base.replace(/\/$/, '')}${path}`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
  })
  if (response.status === 401) {
    throw new CliError(
      'Unauthorized — check EDGEVAULT_API_KEY (create one in the console under your environment).',
    )
  }
  return response
}

export async function fetchExport(options: CliOptions): Promise<EnvironmentExport> {
  const response = await request(options, options.apiUrl, '/machine/v1/export')
  if (!response.ok) throw new CliError(`Export failed: HTTP ${response.status}`)
  return (await response.json()) as EnvironmentExport
}

export async function fetchConfig(
  options: CliOptions,
  key: string,
): Promise<{ key: string; content: string } | null> {
  const response = await request(
    options,
    options.deliveryUrl,
    `/v1/configs/${encodeURIComponent(key)}`,
  )
  if (response.status === 404) return null
  if (!response.ok) throw new CliError(`Read failed: HTTP ${response.status}`)
  return (await response.json()) as { key: string; content: string }
}
