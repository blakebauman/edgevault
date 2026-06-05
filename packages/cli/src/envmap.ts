import type { EnvironmentExport } from './client'

/**
 * Turn an environment export into process env vars. Config keys like
 * `feature.timeout` aren't valid env names, so keys are sanitized (uppercase,
 * non-alphanumerics → `_`, leading digit prefixed). On a sanitized-name
 * collision, secrets win over configs and the later key wins within a kind —
 * collisions are reported so nothing disappears silently.
 */

export function toEnvName(key: string): string {
  const name = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return /^[0-9]/.test(name) ? `_${name}` : name
}

export interface EnvMapping {
  vars: Record<string, string>
  collisions: string[]
}

export function buildEnv(exported: EnvironmentExport): EnvMapping {
  const vars: Record<string, string> = {}
  const collisions: string[] = []

  const assign = (key: string, value: string) => {
    const name = toEnvName(key)
    if (name in vars) collisions.push(`${key} → ${name}`)
    vars[name] = value
  }

  for (const [key, value] of Object.entries(exported.configs)) assign(key, value.content)
  // Secrets assigned last so they win any collision with a config.
  for (const [key, value] of Object.entries(exported.secrets)) assign(key, value)

  return { vars, collisions }
}

/** Render vars as a .env file (values quoted; quotes/newlines escaped). */
export function formatDotenv(vars: Record<string, string>): string {
  return `${Object.entries(vars)
    .map(([name, value]) => {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
      return `${name}="${escaped}"`
    })
    .join('\n')}\n`
}
