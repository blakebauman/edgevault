import {
  ArtifactPanel,
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  EmptyRow,
  ErrorNote,
  Field,
  Input,
  Select,
  Td,
  Th,
} from '@edgevault/ui'
import { Form, Link, useNavigation } from 'react-router'
import { LocalTime } from '../components/local-time'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { humanizeAction } from '../lib/format'
import { getToken, loginRedirect } from '../lib/session.server'
import { getWorkspaceMeta } from '../lib/workspace.server'
import type { Route } from './+types/dashboard.audit'

/**
 * The cold audit warehouse view: every change ever, from the R2 NDJSON store
 * (infinite retention), filterable by date, environment, action, resource and
 * actor. The dashboard's Activity feed is the hot/recent slice; this is the
 * record — and the thing a compliance reviewer is pointed at.
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
  /** secret.revealed only: was a fresh second factor proven for this reveal. */
  stepUp?: boolean
}

type Facets = {
  actions: string[]
  resourceTypes: string[]
  actors: Array<{ userId: string; actor: string | null }>
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Audit history · EdgeVault' }]
}

/** Anomaly alerts share the table with ordinary changes; they should not read
 * like one. Everything else stays neutral — an audit row is a fact, and
 * colouring routine writes would drown the two rows that matter. */
function actionChip(action: string): ChipVariant {
  if (action.startsWith('alert.')) return 'warn'
  if (action === 'secret.revealed' || action === 'audit.exported') return 'kind-secret'
  return 'neutral'
}

const FILTER_KEYS = ['from', 'to', 'env', 'action', 'resourceType', 'actor'] as const

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }
  const url = new URL(request.url)
  const filters = Object.fromEntries(
    FILTER_KEYS.map((k) => [k, url.searchParams.get(k) ?? '']),
  ) as Record<(typeof FILTER_KEYS)[number], string>

  // "Show more" grows the limit; the API caps at 1000 per query.
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
  const query = new URLSearchParams()
  for (const key of FILTER_KEYS) if (filters[key]) query.set(key, filters[key])
  query.set('limit', String(limit))

  const [meta, envsRes, auditRes] = await Promise.all([
    getWorkspaceMeta(env, token, params.workspaceId),
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    env.API_SERVICE.fetch(`${base}/audit?${query}`, { headers }),
  ])
  if (envsRes.status === 401 || envsRes.status === 403) throw loginRedirect(request)

  const environments = envsRes.ok
    ? ((await envsRes.json()) as { environments: EnvironmentSummary[] }).environments
    : []
  let events: AuditEventRow[] = []
  let total = 0
  let facets: Facets = { actions: [], resourceTypes: [], actors: [] }
  let auditError: string | null = null
  if (auditRes.ok) {
    const body = (await auditRes.json()) as {
      events: AuditEventRow[]
      total?: number
      facets?: Facets
    }
    events = body.events
    total = body.total ?? body.events.length
    facets = body.facets ?? facets
  } else auditError = friendlyError(auditRes.status, 'querying the audit warehouse')

  // Preset ranges, computed server-side (the worker's clock, UTC).
  const today = new Date().toISOString().slice(0, 10)
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

  return {
    workspaceId: params.workspaceId,
    workspaceName: meta.name,
    isAdmin: meta.role === 'owner' || meta.role === 'admin',
    environments,
    events,
    total,
    facets,
    auditError,
    filters,
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
    isAdmin,
    environments,
    events,
    total,
    facets,
    auditError,
    filters,
    limit,
    presets,
  } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state === 'loading'

  const current = new URLSearchParams()
  for (const key of FILTER_KEYS) if (filters[key]) current.set(key, filters[key])

  const withParams = (extra: Record<string, string>) => {
    const next = new URLSearchParams(current)
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    return `?${next}`
  }
  const filtered = FILTER_KEYS.some((k) => filters[k])

  // Warehouse events carry no id, and the same (time, action, key) triple can
  // legitimately repeat, so keys are composed with an occurrence counter —
  // stable across re-renders of the same query, unlike a bare array index.
  const rows = (() => {
    const seen = new Map<string, number>()
    return events.map((event) => {
      const base = `${event.at}-${event.action}-${event.key ?? ''}-${event.userId}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return { event, rowKey: n === 0 ? base : `${base}#${n}` }
    })
  })()

  const envSlug = (id?: string) =>
    id ? (environments.find((e) => e.id === id)?.slug ?? id.slice(0, 8)) : null
  const actorLabel = (userId: string, actor: string | null) =>
    actor ?? (userId === 'machine' ? 'machine' : userId.slice(0, 8))

  return (
    <section className="panel is-wide">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Audit history</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
        {isAdmin && !auditError && (
          <Button variant="secondary" asChild>
            {/* A plain anchor, not a router Link: this is a file download, and
                reload={false} navigation would try to render NDJSON as a route. */}
            <a href={`/dashboard/${workspaceId}/audit/export${withParams({})}`} download>
              Export NDJSON
            </a>
          </Button>
        )}
      </header>

      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        The cold warehouse: every recorded configuration and secret change, retained indefinitely.
        Defaults to the last 7 days; ranges are capped at 31 days per query.
      </p>

      <Form method="get" className="my-5 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={filters.from} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={filters.to} />
        </Field>
        <Field label="Environment">
          <Select name="env" defaultValue={filters.env}>
            <option value="">All environments</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} /{e.slug}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Action">
          <Select name="action" defaultValue={filters.action}>
            <option value="">All actions</option>
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {humanizeAction(a)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Resource">
          <Select name="resourceType" defaultValue={filters.resourceType}>
            <option value="">All resources</option>
            {facets.resourceTypes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Actor">
          <Select name="actor" defaultValue={filters.actor}>
            <option value="">Anyone</option>
            {facets.actors.map((a) => (
              <option key={a.userId} value={a.userId}>
                {actorLabel(a.userId, a.actor)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit">Query</Button>
        <span className="flex flex-wrap gap-2 pb-1.5">
          {presets.map((preset) => (
            <Link
              key={preset.label}
              className="rounded-sm border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground no-underline transition-colors hover:border-accent hover:text-accent"
              to={withParams({ from: preset.from, to: preset.to })}
            >
              {preset.label}
            </Link>
          ))}
          {filtered && (
            <Link
              className="rounded-sm border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground no-underline transition-colors hover:border-accent hover:text-accent"
              to="?"
            >
              Clear filters
            </Link>
          )}
        </span>
      </Form>

      {auditError && <ErrorNote>{auditError}</ErrorNote>}

      {!auditError && (
        <>
          <p className="mb-3 text-sm tabular-figures text-muted-foreground">
            Showing {events.length} of {total} event{total === 1 ? '' : 's'} in range
            {events.length >= 1000 ? ' — the 1000-per-query cap; narrow the range' : ''}
          </p>
          <CardTable label="Audit events" stickyHeader>
            <thead>
              <tr>
                <Th>At</Th>
                <Th>Action</Th>
                <Th>Resource</Th>
                <Th>Key</Th>
                <Th>Environment</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody data-pending={busy || undefined}>
              {rows.map(({ event, rowKey }) => (
                <tr key={rowKey}>
                  <Td label="At" className="whitespace-nowrap text-muted-foreground">
                    <LocalTime epoch={event.at} />
                  </Td>
                  <Td label="Action">
                    <Chip variant={actionChip(event.action)}>{humanizeAction(event.action)}</Chip>
                    {event.count && event.count > 1 && (
                      <span className="text-muted-foreground"> ×{event.count}</span>
                    )}
                    {/* Whether a reveal cleared step-up is the single most
                        asked-about detail in this table; it rides the row. */}
                    {event.action === 'secret.revealed' && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground-subtle">
                        {event.stepUp ? 'step-up' : 'no step-up'}
                      </span>
                    )}
                  </Td>
                  <Td label="Resource" className="font-mono text-xs text-muted-foreground">
                    {event.resourceType}
                  </Td>
                  <Td label="Key" className="font-mono text-sm">
                    {event.key ?? '—'}
                  </Td>
                  <Td label="Environment" className="font-mono text-sm text-muted-foreground">
                    {envSlug(event.environmentId) ? `/${envSlug(event.environmentId)}` : '—'}
                  </Td>
                  <Td label="By" className="text-muted-foreground">
                    {actorLabel(event.userId, event.actor)}
                  </Td>
                </tr>
              ))}
              {events.length === 0 && (
                <EmptyRow
                  colSpan={6}
                  title={filtered ? 'No events match these filters' : 'No events in this range'}
                  action={
                    filtered ? (
                      <Button variant="secondary" size="compact" asChild>
                        <Link to="?">Clear filters</Link>
                      </Button>
                    ) : undefined
                  }
                >
                  {filtered
                    ? 'Widen the dates or clear a filter. Facets list only what this workspace has actually recorded, so an empty result means it never happened here.'
                    : 'Make a change and check back — the warehouse fills from the audit queue within seconds of a write.'}
                </EmptyRow>
              )}
            </tbody>
          </CardTable>
          {total > events.length && limit < 1000 && (
            <Button variant="secondary" size="compact" asChild className="mt-3">
              <Link to={withParams({ limit: String(limit + 200) })}>Show 200 more</Link>
            </Button>
          )}

          {isAdmin && events.length > 0 && (
            <>
              <h2>Verifying an export</h2>
              <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                The download carries a SHA-256 of its body in the{' '}
                <code className="font-mono text-xs">x-content-sha256</code> response header. Hash
                the file yourself and compare — the export is only evidence if the reviewer can
                check it wasn't altered in transit or afterwards. Exporting is itself recorded as an{' '}
                <code className="font-mono text-xs">audit.exported</code> event.
              </p>
              <ArtifactPanel className="mt-4" label="In a terminal, after downloading:">
                {`shasum -a 256 edgevault-audit-${workspaceId}.ndjson`}
              </ArtifactPanel>
            </>
          )}
        </>
      )}
    </section>
  )
}
