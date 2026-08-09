import { ArtifactPanel, Button } from '@edgevault/ui'
import { Link } from 'react-router'
import {
  AUDIT_FILTER_KEYS,
  type AuditEventRow,
  type AuditFacets,
  AuditFilterForm,
  AuditTable,
  readAuditFilters,
} from '../components/audit-table'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { getToken, loginRedirect } from '../lib/session.server'
import { getWorkspaceMeta } from '../lib/workspace.server'
import type { Route } from './+types/dashboard.audit'

/**
 * The cold audit warehouse, workspace scope: configuration and secret
 * operations, from the R2 NDJSON store (infinite retention). The dashboard's
 * Activity feed is the hot/recent slice; this is the record.
 *
 * Membership, policy, and identity events live at the org scope instead
 * (routes/org.audit.tsx) — they have no workspace, and folding "someone was
 * made an admin" into a list of config writes helps nobody.
 */

type EnvironmentSummary = { id: string; name: string; slug: string }

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Audit history · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }
  const url = new URL(request.url)
  const filters = readAuditFilters(url)

  // "Show more" grows the limit; the API caps at 1000 per query.
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
  const query = new URLSearchParams()
  for (const key of AUDIT_FILTER_KEYS) if (filters[key]) query.set(key, filters[key])
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
  let facets: AuditFacets = { actions: [], resourceTypes: [], actors: [] }
  let auditError: string | null = null
  if (auditRes.ok) {
    const body = (await auditRes.json()) as {
      events: AuditEventRow[]
      total?: number
      facets?: AuditFacets
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
    organizationId: meta.organizationId,
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
    organizationId,
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

  const current = new URLSearchParams()
  for (const key of AUDIT_FILTER_KEYS) if (filters[key]) current.set(key, filters[key])
  const withParams = (extra: Record<string, string>) => {
    const next = new URLSearchParams(current)
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    return `?${next}`
  }
  const filtered = AUDIT_FILTER_KEYS.some((k) => filters[k])
  const envSlug = (id?: string) =>
    id ? (environments.find((e) => e.id === id)?.slug ?? id.slice(0, 8)) : null

  return (
    <section className="panel is-wide">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Audit history</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
        {isAdmin && !auditError && (
          <Button variant="secondary" asChild>
            {/* A plain anchor, not a router Link: this is a file download, and a
                client-side navigation would try to render NDJSON as a route. */}
            <a href={`/dashboard/${workspaceId}/audit/export${withParams({})}`} download>
              Export NDJSON
            </a>
          </Button>
        )}
      </header>

      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        The cold warehouse: every recorded configuration and secret change, retained indefinitely.
        Defaults to the last 7 days; ranges are capped at 31 days per query.
        {organizationId && (
          <>
            {' '}
            Membership and policy changes are recorded separately, on the{' '}
            <Link to={`/orgs/${organizationId}/audit`}>organization trail</Link>.
          </>
        )}
      </p>

      <AuditFilterForm
        filters={filters}
        facets={facets}
        environments={environments}
        presets={presets}
        withParams={withParams}
      />

      {auditError && <p className="text-destructive">{auditError}</p>}

      {!auditError && (
        <>
          <p className="mb-3 text-sm tabular-figures text-muted-foreground">
            Showing {events.length} of {total} event{total === 1 ? '' : 's'} in range
            {events.length >= 1000 ? ' — the 1000-per-query cap; narrow the range' : ''}
          </p>

          <AuditTable
            events={events}
            filtered={filtered}
            envSlug={envSlug}
            emptyHint="Make a change and check back — the warehouse fills from the audit queue within seconds of a write."
          />

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
