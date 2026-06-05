import { Form, Link, redirect, useNavigation, useSearchParams } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/dashboard.compare'

/**
 * Side-by-side environment comparison. Picks two environments, shows per-key
 * drift (equal / drifted / only-in-one), and offers one-click promotion of a
 * drifted or missing key into the target environment. Secrets compare by
 * presence only — the api never decrypts values for comparison.
 */

type EnvironmentSummary = { id: string; name: string; slug: string }

type DiffResult = { type: string; path: string; oldValue?: unknown; newValue?: unknown }

type ComparisonEntry = {
  key: string
  status: 'equal' | 'drifted' | 'only-in-source' | 'only-in-target' | 'not-comparable'
  source?: { kind: string; version: number; updatedAt: number }
  target?: { kind: string; version: number; updatedAt: number }
  diff?: DiffResult[]
  diffSummary?: string
}

type Comparison = {
  sourceEnvironmentId: string
  targetEnvironmentId: string
  entries: ComparisonEntry[]
  summary: {
    equal: number
    drifted: number
    onlyInSource: number
    onlyInTarget: number
    notComparable: number
  }
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Compare environments · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }

  const envRes = await env.API_SERVICE.fetch(`${base}/environments`, { headers })
  if (envRes.status === 401 || envRes.status === 403) throw redirect('/login')
  const environments = envRes.ok
    ? ((await envRes.json()) as { environments: EnvironmentSummary[] }).environments
    : []

  const url = new URL(request.url)
  const source = url.searchParams.get('source')
  const target = url.searchParams.get('target')

  let comparison: Comparison | null = null
  let compareError: string | null = null
  if (source && target) {
    if (source === target) {
      compareError = 'Pick two different environments to compare.'
    } else {
      const res = await env.API_SERVICE.fetch(
        `${base}/environments/compare?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
        { headers },
      )
      if (res.ok) comparison = ((await res.json()) as { comparison: Comparison }).comparison
      else compareError = res.status === 404 ? 'Unknown environment.' : 'Comparison failed.'
    }
  }

  return { workspaceId: params.workspaceId, environments, comparison, compareError }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const form = await request.formData()
  const body = {
    sourceEnvironmentId: String(form.get('sourceEnvironmentId') ?? ''),
    targetEnvironmentId: String(form.get('targetEnvironmentId') ?? ''),
    key: String(form.get('key') ?? ''),
  }
  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/promotions`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) return { error: `Promotion failed (${res.status})` }
  // Re-run the loader so the row flips to "equal".
  throw redirect(new URL(request.url).pathname + new URL(request.url).search)
}

const STATUS_LABEL: Record<ComparisonEntry['status'], string> = {
  equal: 'equal',
  drifted: 'drifted',
  'only-in-source': 'missing in target',
  'only-in-target': 'only in target',
  'not-comparable': 'secret (not compared)',
}

export default function CompareEnvironments({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, environments, comparison, compareError } = loaderData
  const [searchParams] = useSearchParams()
  const navigation = useNavigation()
  const source = searchParams.get('source') ?? ''
  const target = searchParams.get('target') ?? ''
  const envName = (id: string) => environments.find((e) => e.id === id)?.slug ?? id

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Compare environments</p>
            <h1>{workspaceId}</h1>
          </div>
          <Link to={`/dashboard/${workspaceId}`} className="secondary button">
            ← Workspace
          </Link>
        </header>

        <Form method="get" className="compare-pickers">
          <label>
            Source
            <select name="source" defaultValue={source}>
              <option value="">Choose…</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} /{e.slug}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">→</span>
          <label>
            Target
            <select name="target" defaultValue={target}>
              <option value="">Choose…</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} /{e.slug}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Compare</button>
        </Form>

        {compareError && <p className="error-text">{compareError}</p>}
        {actionData?.error && <p className="error-text">{actionData.error}</p>}

        {comparison && (
          <>
            <p className="muted compare-summary">
              {comparison.summary.equal} equal · {comparison.summary.drifted} drifted ·{' '}
              {comparison.summary.onlyInSource} missing in target ·{' '}
              {comparison.summary.onlyInTarget} only in target · {comparison.summary.notComparable}{' '}
              secrets not compared
            </p>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Status</th>
                  <th>{envName(comparison.sourceEnvironmentId)}</th>
                  <th>{envName(comparison.targetEnvironmentId)}</th>
                  <th>Changes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {comparison.entries.map((entry) => (
                  <tr key={entry.key} className={`row-${entry.status}`}>
                    <td className="mono">{entry.key}</td>
                    <td>
                      <span className={`status status-${entry.status}`}>
                        {STATUS_LABEL[entry.status]}
                      </span>
                    </td>
                    <td className="muted">{entry.source ? `v${entry.source.version}` : '—'}</td>
                    <td className="muted">{entry.target ? `v${entry.target.version}` : '—'}</td>
                    <td className="muted">{entry.diffSummary ?? ''}</td>
                    <td>
                      {(entry.status === 'drifted' || entry.status === 'only-in-source') && (
                        <Form method="post">
                          <input type="hidden" name="key" value={entry.key} />
                          <input
                            type="hidden"
                            name="sourceEnvironmentId"
                            value={comparison.sourceEnvironmentId}
                          />
                          <input
                            type="hidden"
                            name="targetEnvironmentId"
                            value={comparison.targetEnvironmentId}
                          />
                          <button
                            type="submit"
                            className="secondary compact"
                            disabled={navigation.state !== 'idle'}
                          >
                            Promote →
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
                {comparison.entries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Both environments are empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  )
}
