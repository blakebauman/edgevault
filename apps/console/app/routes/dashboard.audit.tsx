import { Button, CardTable, Chip, ErrorNote, Field, Input, Select, Td, Th } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { LocalTime } from '../components/local-time'
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
          <Button variant="secondary" asChild>
            <Link to={`/dashboard/${workspaceId}`}>← Workspace</Link>
          </Button>
        </header>

        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          The cold warehouse: every recorded change, retained indefinitely. Defaults to the last 7
          days; ranges are capped at 31 days per query.
        </p>

        <Form method="get" className="my-5 flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" name="from" defaultValue={from} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={to} />
          </Field>
          <Field label="Environment">
            <Select name="env" defaultValue={envId}>
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} /{e.slug}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Query</Button>
        </Form>

        {auditError && <ErrorNote>{auditError}</ErrorNote>}

        {!auditError && (
          <>
            <p className="mb-3 text-sm tabular-nums text-muted-foreground">
              {events.length} event{events.length === 1 ? '' : 's'}
              {events.length === 200 ? ' (showing the most recent 200 — narrow the range)' : ''}
            </p>
            <CardTable label="Audit events">
              <thead>
                <tr>
                  <Th>At</Th>
                  <Th>Action</Th>
                  <Th>Key</Th>
                  <Th>Environment</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: warehouse events carry no id; the list is read-only and replaced wholesale per query
                  <tr key={`${event.at}-${event.action}-${event.key ?? ''}-${i}`}>
                    <Td label="At" className="text-muted-foreground">
                      <LocalTime epoch={event.at} />
                    </Td>
                    <Td label="Action">
                      <Chip variant="neutral">{event.action}</Chip>
                      {event.count && event.count > 1 && (
                        <span className="text-muted-foreground"> ×{event.count}</span>
                      )}
                    </Td>
                    <Td label="Key" className="font-mono text-sm">
                      {event.key ?? '—'}
                    </Td>
                    <Td label="Environment" className="font-mono text-sm text-muted-foreground">
                      {envSlug(event.environmentId) ? `/${envSlug(event.environmentId)}` : '—'}
                    </Td>
                    <Td label="By" className="text-muted-foreground">
                      {event.actor ?? event.userId.slice(0, 8)}
                    </Td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <Td colSpan={5} className="text-muted-foreground">
                      No events in this range. Widen the dates, or make a change and check back —
                      the warehouse fills from the audit queue within seconds.
                    </Td>
                  </tr>
                )}
              </tbody>
            </CardTable>
          </>
        )}
      </section>
    </main>
  )
}
