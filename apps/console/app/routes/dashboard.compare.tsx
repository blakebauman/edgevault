import { useState } from 'react'
import { Form, Link, redirect, useNavigation, useSearchParams } from 'react-router'
import { getToken } from '../lib/session.server'
import { getWorkspaceName } from '../lib/workspace.server'
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

  const [envRes, workspaceName] = await Promise.all([
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    getWorkspaceName(env, token, params.workspaceId),
  ])
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

  return { workspaceId: params.workspaceId, workspaceName, environments, comparison, compareError }
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
  // Through the durable workflow, not the direct endpoint: every promotion is
  // risk-scanned, and risky targets park at the approval gate instead of
  // applying silently.
  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/promotion-workflows`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) return { error: `Promotion failed (${res.status})` }
  return { started: body.key }
}

const STATUS_LABEL: Record<ComparisonEntry['status'], string> = {
  equal: 'equal',
  drifted: 'drifted',
  'only-in-source': 'missing in target',
  'only-in-target': 'only in target',
  'not-comparable': 'secret (not compared)',
}

/** One-sided secrets fall through the DO's not-comparable branch (it only fires
 * when the key exists in both environments) — label them honestly here. */
function entryLabel(entry: ComparisonEntry): string {
  const kind = (entry.source ?? entry.target)?.kind
  if (kind === 'secret' && entry.status !== 'not-comparable') {
    return `secret · ${STATUS_LABEL[entry.status]}`
  }
  return STATUS_LABEL[entry.status]
}

export default function CompareEnvironments({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, environments, comparison, compareError } = loaderData
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
            <h1>{workspaceName ?? workspaceId}</h1>
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

        {compareError && (
          <p className="error-text" role="alert">
            {compareError}
          </p>
        )}
        {actionData && 'error' in actionData && (
          <p className="error-text" role="alert">
            {actionData.error}
          </p>
        )}
        {actionData && 'started' in actionData && (
          <p className="status-note" role="status">
            Promotion of "{actionData.started}" started — it applies in seconds, or parks for
            approval if the risk scan flags it. Track it on the workspace dashboard.
          </p>
        )}

        {comparison && (
          <>
            <p className="muted compare-summary">
              {comparison.summary.equal} equal · {comparison.summary.drifted} drifted ·{' '}
              {comparison.summary.onlyInSource} missing in target ·{' '}
              {comparison.summary.onlyInTarget} only in target · {comparison.summary.notComparable}{' '}
              secrets not compared
            </p>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern) */}
            <section className="table-scroll" aria-label="Comparison" tabIndex={0}>
              <table className="compare-table cards-sm">
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
                      <td data-label="Status">
                        <span
                          className={`status ${
                            (entry.source ?? entry.target)?.kind === 'secret'
                              ? 'status-not-comparable'
                              : `status-${entry.status}`
                          }`}
                        >
                          {entryLabel(entry)}
                        </span>
                      </td>
                      <td
                        className="muted"
                        data-label={`/${envName(comparison.sourceEnvironmentId)}`}
                      >
                        {entry.source ? `v${entry.source.version}` : '—'}
                      </td>
                      <td
                        className="muted"
                        data-label={`/${envName(comparison.targetEnvironmentId)}`}
                      >
                        {entry.target ? `v${entry.target.version}` : '—'}
                      </td>
                      <td className="muted" data-label="Changes">
                        {entry.diffSummary ?? ''}
                      </td>
                      <td>
                        {(entry.status === 'drifted' || entry.status === 'only-in-source') && (
                          <PromoteControl
                            entryKey={entry.key}
                            sourceEnvironmentId={comparison.sourceEnvironmentId}
                            targetEnvironmentId={comparison.targetEnvironmentId}
                            targetName={envName(comparison.targetEnvironmentId)}
                            isSecret={(entry.source ?? entry.target)?.kind === 'secret'}
                            busy={navigation.state !== 'idle'}
                          />
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
            </section>
          </>
        )}
      </section>
    </main>
  )
}

/** Promotion mutates another environment's config — a two-step inline confirm,
 * never a single click. The confirm wears the danger voice (the safe exit stays
 * brand-colored); secrets say plainly that the sealed value is copied unseen. */
function PromoteControl({
  entryKey,
  sourceEnvironmentId,
  targetEnvironmentId,
  targetName,
  isSecret,
  busy,
}: {
  entryKey: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  targetName: string
  isSecret: boolean
  busy: boolean
}) {
  const [arming, setArming] = useState(false)

  if (!arming) {
    return (
      <button
        type="button"
        className="secondary compact"
        disabled={busy}
        onClick={() => setArming(true)}
      >
        {isSecret ? 'Promote secret →' : 'Promote →'}
      </button>
    )
  }

  return (
    <div className="confirm-row">
      <p className="confirm-note">
        {isSecret
          ? `Copy this secret's sealed value to /${targetName}? The value is never displayed.`
          : `Overwrites /${targetName}; there is no undo.`}
      </p>
      <Form method="post" onSubmit={() => setArming(false)}>
        <input type="hidden" name="key" value={entryKey} />
        <input type="hidden" name="sourceEnvironmentId" value={sourceEnvironmentId} />
        <input type="hidden" name="targetEnvironmentId" value={targetEnvironmentId} />
        <button type="submit" className="danger compact" disabled={busy}>
          Confirm → /{targetName}
        </button>
      </Form>
      <button type="button" className="secondary compact" onClick={() => setArming(false)}>
        Cancel
      </button>
    </div>
  )
}
