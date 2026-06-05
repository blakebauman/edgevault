import { Form, Link, redirect } from 'react-router'
import { formatTime } from '../lib/format'
import { getToken } from '../lib/session.server'
import { getWorkspaceName } from '../lib/workspace.server'
import type { Route } from './+types/dashboard.audit'

/**
 * The cold audit warehouse view: every change ever, from the R2 NDJSON store
 * (infinite retention), date-ranged and filterable by environment. The
 * dashboard's Activity feed is the hot/recent slice; this is the record.
 */

type EnvironmentSummary = { id: string; name: string; slug: string }

type AuditEventRow = {
  at: number
  environmentId?: string
  action: string
  resourceType: string
  key?: string
  userId: string
  actor: string | null
  count?: number
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Audit history · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }
  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  const envId = url.searchParams.get('env') ?? ''

  const query = new URLSearchParams()
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  if (envId) query.set('env', envId)
  query.set('limit', '200')

  const [workspaceName, envsRes, auditRes] = await Promise.all([
    getWorkspaceName(env, token, params.workspaceId),
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    env.API_SERVICE.fetch(`${base}/audit?${query}`, { headers }),
  ])
  if (envsRes.status === 401 || envsRes.status === 403) throw redirect('/login')

  const environments = envsRes.ok
    ? ((await envsRes.json()) as { environments: EnvironmentSummary[] }).environments
    : []
  let events: AuditEventRow[] = []
  let auditError: string | null = null
  if (auditRes.ok) events = ((await auditRes.json()) as { events: AuditEventRow[] }).events
  else auditError = `The audit warehouse is unavailable right now (${auditRes.status}).`

  return {
    workspaceId: params.workspaceId,
    workspaceName,
    environments,
    events,
    auditError,
    from,
    to,
    envId,
  }
}

export default function AuditHistory({ loaderData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, environments, events, auditError, from, to, envId } =
    loaderData
  const envSlug = (id?: string) =>
    id ? (environments.find((e) => e.id === id)?.slug ?? id.slice(0, 8)) : null

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Audit history</p>
            <h1>{workspaceName ?? workspaceId}</h1>
          </div>
          <Link to={`/dashboard/${workspaceId}`} className="secondary button">
            ← Workspace
          </Link>
        </header>

        <p className="muted">
          The cold warehouse: every recorded change, retained indefinitely. Defaults to the last 7
          days; ranges are capped at 31 days per query.
        </p>

        <Form method="get" className="compare-pickers">
          <label>
            From
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label>
            To
            <input type="date" name="to" defaultValue={to} />
          </label>
          <label>
            Environment
            <select name="env" defaultValue={envId}>
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} /{e.slug}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Query</button>
        </Form>

        {auditError && (
          <p className="error-text" role="alert">
            {auditError}
          </p>
        )}

        {!auditError && (
          <>
            <p className="muted compare-summary">
              {events.length} event{events.length === 1 ? '' : 's'}
              {events.length === 200 ? ' (showing the most recent 200 — narrow the range)' : ''}
            </p>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern) */}
            <section className="table-scroll" aria-label="Audit events" tabIndex={0}>
              <table className="compare-table cards-sm">
                <thead>
                  <tr>
                    <th>At</th>
                    <th>Action</th>
                    <th>Key</th>
                    <th>Environment</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: warehouse events carry no id; the list is read-only and replaced wholesale per query
                    <tr key={`${event.at}-${event.action}-${event.key ?? ''}-${i}`}>
                      <td className="muted" data-label="At">
                        {formatTime(event.at)}
                      </td>
                      <td data-label="Action">
                        <span className="status chip-neutral">{event.action}</span>
                        {event.count && event.count > 1 && (
                          <span className="muted"> ×{event.count}</span>
                        )}
                      </td>
                      <td className="mono" data-label="Key">
                        {event.key ?? '—'}
                      </td>
                      <td className="muted mono" data-label="Environment">
                        {envSlug(event.environmentId) ? `/${envSlug(event.environmentId)}` : '—'}
                      </td>
                      <td className="muted" data-label="By">
                        {event.actor ?? event.userId.slice(0, 8)}
                      </td>
                    </tr>
                  ))}
                  {events.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No events in this range. Widen the dates, or make a change and check back —
                        the warehouse fills from the audit queue within seconds.
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
