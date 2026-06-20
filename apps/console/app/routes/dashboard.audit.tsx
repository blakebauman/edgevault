import { Button, CardTable, Chip, ErrorNote, Field, Input, Select, Td, Th } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { Crumbs } from '../components/crumbs'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { humanizeAction } from '../lib/format'
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

  // "Show more" grows the limit; the API caps at 1000 per query.
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
  const query = new URLSearchParams()
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  if (envId) query.set('env', envId)
  query.set('limit', String(limit))

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
  let total = 0
  let auditError: string | null = null
  if (auditRes.ok) {
    const body = (await auditRes.json()) as { events: AuditEventRow[]; total?: number }
    events = body.events
    total = body.total ?? body.events.length
  } else auditError = friendlyError(auditRes.status, 'querying the audit warehouse')

  // Preset ranges, computed server-side (the worker's clock, UTC).
  const today = new Date().toISOString().slice(0, 10)
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

  return {
    workspaceId: params.workspaceId,
    workspaceName,
    environments,
    events,
    total,
    auditError,
    from,
    to,
    envId,
    limit,
    presets: [
      { label: 'Last 7 days', from: daysAgo(6), to: today },
      { label: 'Last 30 days', from: daysAgo(29), to: today },
    ],
  }
}

export default function AuditHistory({ loaderData }: Route.ComponentProps) {
  const {
    workspaceId,
    workspaceName,
    environments,
    events,
    total,
    auditError,
    from,
    to,
    envId,
    limit,
    presets,
  } = loaderData
  const moreParams = new URLSearchParams()
  if (from) moreParams.set('from', from)
  if (to) moreParams.set('to', to)
  if (envId) moreParams.set('env', envId)
  moreParams.set('limit', String(limit + 200))
  const envSlug = (id?: string) =>
    id ? (environments.find((e) => e.id === id)?.slug ?? id.slice(0, 8)) : null

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <Crumbs
            items={[
              { label: 'workspaces', to: '/' },
              { label: workspaceName ?? 'workspace', to: `/dashboard/${workspaceId}` },
              { label: 'audit' },
            ]}
          />
          <p className="eyebrow">Audit history</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
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
        <span className="flex gap-3 pb-2.5">
          {presets.map((preset) => (
            <Link
              key={preset.label}
              className="font-mono text-xs text-accent underline underline-offset-4"
              to={`?from=${preset.from}&to=${preset.to}${envId ? `&env=${envId}` : ''}`}
            >
              {preset.label}
            </Link>
          ))}
        </span>
      </Form>

      {auditError && <ErrorNote>{auditError}</ErrorNote>}

      {!auditError && (
        <>
          <p className="mb-3 text-sm tabular-nums text-muted-foreground">
            Showing {events.length} of {total} event{total === 1 ? '' : 's'} in range
            {events.length >= 1000 ? ' — the 1000-per-query cap; narrow the range' : ''}
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
                    <Chip variant="neutral">{humanizeAction(event.action)}</Chip>
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
                    No events in this range. Widen the dates, or make a change and check back — the
                    warehouse fills from the audit queue within seconds.
                  </Td>
                </tr>
              )}
            </tbody>
          </CardTable>
          {total > events.length && limit < 1000 && (
            <Button variant="secondary" size="compact" asChild className="mt-3">
              <Link to={`?${moreParams}`}>Show 200 more</Link>
            </Button>
          )}
        </>
      )}
    </section>
  )
}
