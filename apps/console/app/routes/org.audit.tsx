import { ArtifactPanel, Button, Callout } from '@edgevault/ui'
import { Link } from 'react-router'
import {
  AUDIT_FILTER_KEYS,
  type AuditEventRow,
  type AuditFacets,
  AuditFilterForm,
  AuditTable,
  readAuditFilters,
} from '../components/audit-table'
import { Forbidden } from '../components/forbidden'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { requireOrg } from '../lib/org.server'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/org.audit'

/**
 * The organization trail: membership, policy, credentials, and the identity
 * plane's policy refusals.
 *
 * Until now the warehouse held configuration and secret operations only, so
 * "who made this person an admin" and "did require-MFA actually stop anyone"
 * had no answer in the product. Those are the first two questions on a vendor
 * security questionnaire.
 *
 * Admin-only, unlike the workspace trail any member can read: this names the
 * people it records.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Organization audit · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const org = await requireOrg(env, token, params.orgId, request)
  const url = new URL(request.url)
  const filters = readAuditFilters(url)
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)

  const today = new Date().toISOString().slice(0, 10)
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const presets = [
    { label: 'Last 7 days', from: daysAgo(6), to: today },
    { label: 'Last 30 days', from: daysAgo(29), to: today },
  ]

  if (!org.isAdmin) {
    return {
      org,
      events: [] as AuditEventRow[],
      total: 0,
      facets: { actions: [], resourceTypes: [], actors: [] } as AuditFacets,
      auditError: null,
      filters,
      limit,
      presets,
    }
  }

  const query = new URLSearchParams()
  for (const key of AUDIT_FILTER_KEYS) if (filters[key]) query.set(key, filters[key])
  query.set('limit', String(limit))

  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/audit?${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (res.status === 401) throw loginRedirect(request)

  let events: AuditEventRow[] = []
  let total = 0
  let facets: AuditFacets = { actions: [], resourceTypes: [], actors: [] }
  let auditError: string | null = null
  if (res.ok) {
    const body = (await res.json()) as {
      events: AuditEventRow[]
      total?: number
      facets?: AuditFacets
    }
    events = body.events
    total = body.total ?? body.events.length
    facets = body.facets ?? facets
  } else auditError = friendlyError(res.status, 'querying the organization trail')

  return { org, events, total, facets, auditError, filters, limit, presets }
}

export default function OrgAudit({ loaderData }: Route.ComponentProps) {
  const { org, events, total, facets, auditError, filters, limit, presets } = loaderData

  const current = new URLSearchParams()
  for (const key of AUDIT_FILTER_KEYS) if (filters[key]) current.set(key, filters[key])
  const withParams = (extra: Record<string, string>) => {
    const next = new URLSearchParams(current)
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    return `?${next}`
  }
  const filtered = AUDIT_FILTER_KEYS.some((k) => filters[k])

  return (
    <section className="panel is-wide">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Organization audit</p>
          <h1>{org.name}</h1>
        </div>
        {org.isAdmin && !auditError && (
          <Button variant="secondary" asChild>
            <a href={`/orgs/${org.id}/audit/export${withParams({})}`} download>
              Export NDJSON
            </a>
          </Button>
        )}
      </header>

      {!org.isAdmin ? (
        <Forbidden subject="read the organization trail" backTo={`/orgs/${org.id}`} />
      ) : (
        <>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Membership, role, policy, and credential changes, plus sign-ins refused by this
            organization's own policy. Configuration and secret operations are recorded per
            workspace, on each workspace's audit page.
          </p>

          <Callout tone="info" className="mt-4">
            Not yet covered: password changes, MFA enrollment, passkey changes, and session
            revocations. Those are account-level actions with no single organization, so attributing
            them here would be a guess.
          </Callout>

          <AuditFilterForm
            filters={filters}
            facets={facets}
            presets={presets}
            withParams={withParams}
          />

          {auditError && <p className="text-destructive">{auditError}</p>}

          {!auditError && (
            <>
              <p className="mb-3 text-sm tabular-figures text-muted-foreground">
                Showing {events.length} of {total} event{total === 1 ? '' : 's'} in range
              </p>

              <AuditTable
                events={events}
                filtered={filtered}
                emptyHint="Change a role, invite someone, or adjust the security policy and check back — the trail fills from the audit queue within seconds."
              />

              {total > events.length && limit < 1000 && (
                <Button variant="secondary" size="compact" asChild className="mt-3">
                  <Link to={withParams({ limit: String(limit + 200) })}>Show 200 more</Link>
                </Button>
              )}

              {events.length > 0 && (
                <>
                  <h2>Verifying an export</h2>
                  <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                    Same contract as the workspace trail: the download carries a SHA-256 of its body
                    in the <code className="font-mono text-xs">x-content-sha256</code> header, and
                    exporting is itself recorded.
                  </p>
                  <ArtifactPanel className="mt-4" label="In a terminal, after downloading:">
                    {`shasum -a 256 edgevault-org-audit-${org.id}.ndjson`}
                  </ArtifactPanel>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
