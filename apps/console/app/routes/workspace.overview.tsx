import type { WorkspaceEvent } from '@edgevault/realtime'
import { useWorkspaceEvents } from '@edgevault/realtime/react'
import {
  ActionGroup,
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  ErrorNote,
  Input,
  StatusNote,
  Td,
  Th,
} from '@edgevault/ui'
import { useState } from 'react'
import { Form, Link, redirect, useNavigation, useRouteLoaderData } from 'react-router'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { humanizeAction } from '../lib/format'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/workspace.overview'
import type { loader as workspaceLoader } from './workspace'

/**
 * The workspace overview (home): an attention banner for parked promotions, a
 * two-column board — recent activity (live events on top) + semantic search on
 * the left, the environment board + workspace facts on the right — and the
 * promotions table with its approval gate. Navigation and the workspace identity
 * live in the surrounding shell.
 */

type EnvSummary = { id: string; name: string; slug: string }

type EnvScore = EnvSummary & {
  configs: number
  flags: number
  secrets: number
  lastChange: number | null
}

type ActivityEntry = {
  id: string
  action: string
  resourceType: string
  resourceId: string
  userId: string | null
  actor: string | null
  environmentId: string | null
  createdAt: number
}

type PromotionRow = {
  id: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  key: string
  status: 'pending' | 'completed' | 'failed'
  createdAt: number
  workflowInstanceId: string | null
  riskLevel: string | null
  actor: string | null
}

type SearchHit = { key: string; environmentId: string; kind: string; score: number }

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.workspaceName ?? 'Workspace'} · EdgeVault` }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const query = new URL(request.url).searchParams.get('q')?.trim() || null

  const [envsRes, activityRes, promotionsRes, searchRes] = await Promise.all([
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    env.API_SERVICE.fetch(`${base}/activity`, { headers }),
    env.API_SERVICE.fetch(`${base}/promotions`, { headers }),
    query
      ? env.API_SERVICE.fetch(`${base}/search?q=${encodeURIComponent(query)}`, { headers })
      : Promise.resolve(null),
  ])
  if (envsRes.status === 401 || envsRes.status === 403) throw redirect('/login')

  const environments = envsRes.ok
    ? ((await envsRes.json()) as { environments: EnvSummary[] }).environments
    : []

  // Box-score: one configs fetch per environment, in parallel. Environments
  // are few; the DO answers from SQLite in one hop.
  const scores: EnvScore[] = await Promise.all(
    environments.map(async (e) => {
      const res = await env.API_SERVICE.fetch(`${base}/environments/${e.id}/configs`, { headers })
      const configs = res.ok
        ? ((await res.json()) as { configs: Array<{ kind: string; updatedAt: number }> }).configs
        : []
      return {
        ...e,
        configs: configs.filter((c) => c.kind === 'config').length,
        flags: configs.filter((c) => c.kind === 'flag').length,
        secrets: configs.filter((c) => c.kind === 'secret').length,
        lastChange: configs.length ? Math.max(...configs.map((c) => c.updatedAt)) : null,
      }
    }),
  )

  const activity = activityRes.ok
    ? ((await activityRes.json()) as { activity: ActivityEntry[] }).activity
    : []
  const promotions = promotionsRes.ok
    ? ((await promotionsRes.json()) as { promotions: PromotionRow[] }).promotions
    : []

  let hits: SearchHit[] | null = null
  let searchError: string | null = null
  if (searchRes) {
    if (searchRes.ok) hits = ((await searchRes.json()) as { hits: SearchHit[] }).hits
    else searchError = friendlyError(searchRes.status, 'searching')
  }

  return {
    workspaceId: params.workspaceId,
    workspaceName: null as string | null,
    scores,
    activity: activity.slice(0, 20),
    promotions: promotions.slice(0, 10),
    query,
    hits,
    searchError,
    wsUrl: `${env.API_WS_BASE}/api/v1/workspaces/${params.workspaceId}/ws?token=${encodeURIComponent(token)}`,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')

  // Resolve a promotion parked at the approval gate (sends the workflow event).
  if (intent === 'approve' || intent === 'reject') {
    const instanceId = String(form.get('instanceId') ?? '')
    const res = await env.API_SERVICE.fetch(`${base}/promotion-workflows/${instanceId}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ approved: intent === 'approve' }),
    })
    if (res.status === 403) {
      return { error: 'Resolving a promotion requires an org owner or admin.' }
    }
    if (!res.ok) {
      const doing = intent === 'approve' ? 'approving the promotion' : 'rejecting the promotion'
      return { error: friendlyError(res.status, doing) }
    }
    return intent === 'approve' ? { approved: true } : { rejected: true }
  }

  return { error: 'Unknown action' }
}

function describe(event: WorkspaceEvent): string {
  switch (event.type) {
    case 'config.changed':
      return `${event.kind} "${event.key}" changed → v${event.version}`
    case 'config.deleted':
      return `"${event.key}" deleted`
    case 'environment.created':
      return `environment "${event.slug}" created`
    case 'promotion.completed':
      return `"${event.key}" promoted to another environment`
    case 'presence':
      return `${event.users.length} online`
    default:
      return event.type
  }
}

function describeActivity(entry: ActivityEntry, envSlug: (id: string) => string): string {
  // environment rows carry the env's id as resourceId — show the slug, not a UUID
  const resource =
    entry.resourceType === 'environment' ? `/${envSlug(entry.resourceId)}` : entry.resourceId
  return `${humanizeAction(entry.action)} · ${resource}`
}

const PROMOTION_CHIP: Record<PromotionRow['status'], ChipVariant> = {
  completed: 'ok',
  pending: 'warn',
  failed: 'danger',
}

const RISK_CHIP: Record<string, ChipVariant> = {
  low: 'neutral',
  medium: 'warn',
  high: 'danger',
}

export default function Overview({ loaderData, actionData }: Route.ComponentProps) {
  const { scores, activity, promotions, query, hits, searchError, wsUrl, workspaceId } = loaderData
  const workspace = useRouteLoaderData<typeof workspaceLoader>('routes/workspace')
  const workspaceName = workspace?.workspaceName ?? workspaceId
  const isAdmin = workspace?.role === 'owner' || workspace?.role === 'admin'
  const [events, setEvents] = useState<Array<{ k: string; e: WorkspaceEvent }>>([])
  const status = useWorkspaceEvents(wsUrl, (event) =>
    setEvents((prev) => [{ k: crypto.randomUUID(), e: event }, ...prev].slice(0, 20)),
  )
  const envSlug = (id: string) => scores.find((s) => s.id === id)?.slug ?? id.slice(0, 8)
  const busy = useNavigation().state !== 'idle'
  const totalItems = scores.reduce((n, s) => n + s.configs + s.flags + s.secrets, 0)
  const pendingCount = promotions.filter((p) => p.status === 'pending').length

  return (
    <section className="panel is-wide">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{workspaceName}</h1>
          <p className="ov-sub">
            {scores.length} environment{scores.length === 1 ? '' : 's'} · {totalItems} item
            {totalItems === 1 ? '' : 's'}
          </p>
        </div>
      </header>

      {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
      {actionData && 'approved' in actionData && (
        <StatusNote>
          Approved — the workflow is applying the snapshotted value and verifying the edge read-back
          now.
        </StatusNote>
      )}
      {actionData && 'rejected' in actionData && (
        <StatusNote>Rejected — the promotion is closed; nothing was applied.</StatusNote>
      )}

      {pendingCount > 0 && (
        <Link to={`/dashboard/${workspaceId}/compare`} className="attention">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <span className="grow">
            <b>
              {pendingCount} promotion{pendingCount === 1 ? '' : 's'}
            </b>{' '}
            awaiting approval at the risk gate.
          </span>
          <span className="go">Review →</span>
        </Link>
      )}

      <div className="home-grid">
        <div>
          <div className="ov-panel">
            <div className="ov-panel-head">
              <h2>Recent activity</h2>
              <span className={`dot ${status}`} role="status">
                <span aria-hidden="true">● </span>
                {status}
              </span>
              <Link className="more" to={`/dashboard/${workspaceId}/audit`}>
                Audit log
              </Link>
            </div>
            <div className="ov-panel-body">
              <ul className="feed">
                {events.map(({ k, e }) => (
                  <li key={k} className="feed-live">
                    <span className="live-dot" aria-hidden="true">
                      ●{' '}
                    </span>
                    <span className="visually-hidden">live: </span>
                    {describe(e)}
                  </li>
                ))}
                {activity.map((entry) => (
                  <li key={entry.id}>
                    {describeActivity(entry, envSlug)}
                    {entry.environmentId && (
                      <span className="font-mono text-sm text-muted-foreground">
                        {' '}
                        /{envSlug(entry.environmentId)}
                      </span>
                    )}{' '}
                    <span className="text-xs text-muted-foreground">
                      {entry.actor ? `${entry.actor} · ` : ''}
                      <LocalTime epoch={entry.createdAt} />
                    </span>
                  </li>
                ))}
                {events.length === 0 && activity.length === 0 && (
                  <li className="text-muted-foreground">No changes recorded yet.</li>
                )}
              </ul>
            </div>
          </div>

          <div className="ov-panel">
            <div className="ov-panel-head">
              <h2>Search</h2>
            </div>
            <div className="ov-panel-body">
              <p className="m-0 mb-2 text-sm text-muted-foreground">
                Semantic — find config by meaning, not key name.
              </p>
              <Form method="get" className="flex gap-2">
                <Input
                  type="search"
                  name="q"
                  className="flex-1"
                  defaultValue={query ?? ''}
                  placeholder='e.g. "the timeout we raised during the incident"'
                  aria-label="Search configs"
                />
                <Button type="submit">Search</Button>
              </Form>
              {searchError && <ErrorNote>{searchError}</ErrorNote>}
              {hits && (
                <ul className="feed" aria-label="Search results">
                  {hits.map((hit) => (
                    <li key={`${hit.environmentId}:${hit.key}`}>
                      <Link to={`/dashboard/${workspaceId}/env/${hit.environmentId}/config`}>
                        <span className="font-mono text-sm">{hit.key}</span>
                      </Link>{' '}
                      <span className="font-mono text-sm text-muted-foreground">
                        /{envSlug(hit.environmentId)} · {hit.kind} · {hit.score.toFixed(2)}
                      </span>
                    </li>
                  ))}
                  {hits.length === 0 && (
                    <li className="text-muted-foreground">No matches for "{query}".</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="ov-panel">
            <div className="ov-panel-head">
              <h2>Environments</h2>
              <Link className="more" to={`/dashboard/${workspaceId}/compare`}>
                Compare
              </Link>
            </div>
            <div className="ov-panel-body">
              {scores.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">
                  No environments yet —{' '}
                  <Link to={`/dashboard/${workspaceId}/environments`}>create one</Link> to add
                  config, flags, secrets, and content.
                </p>
              ) : (
                scores.map((s) => (
                  <div key={s.id} className="envmini">
                    <span className="nm">
                      <Link to={`/dashboard/${workspaceId}/env/${s.id}/config`}>{s.name}</Link>
                    </span>
                    <span className="ct" title="configs · flags · secrets">
                      {s.configs} · {s.flags} · {s.secrets}
                    </span>
                    <Button variant="secondary" size="compact" asChild>
                      <Link to={`/dashboard/${workspaceId}/env/${s.id}/config`}>Open →</Link>
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="ov-panel">
            <div className="ov-panel-head">
              <h2>This workspace</h2>
            </div>
            <div className="ov-panel-body">
              <div className="fact">
                <span className="lbl">Environments</span>
                <span className="val">{scores.length}</span>
              </div>
              <div className="fact">
                <span className="lbl">Items</span>
                <span className="val">{totalItems}</span>
              </div>
              <div className="fact">
                <span className="lbl">Pending promotions</span>
                <span className="val">{pendingCount}</span>
              </div>
              <div className="fact">
                <span className="lbl">Live updates</span>
                <span className="val">{status}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {promotions.length > 0 && (
        <>
          <h2>Promotions</h2>
          {promotions.some((p) => p.status === 'pending' && p.workflowInstanceId) && (
            <p className="mb-2 text-sm text-muted-foreground">
              Pending rows are parked at the approval gate — the risk scan flagged the target.
              Approving applies the value snapshotted at request time.
            </p>
          )}
          <CardTable label="Promotions">
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>From → To</Th>
                <Th>Status</Th>
                <Th>Risk</Th>
                <Th>By</Th>
                <Th>At</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {promotions.map((p) => (
                <tr key={p.id}>
                  <Td className="font-mono text-sm">{p.key}</Td>
                  <Td label="From → To" className="font-mono text-sm text-muted-foreground">
                    /{envSlug(p.sourceEnvironmentId)} → /{envSlug(p.targetEnvironmentId)}
                  </Td>
                  <Td label="Status">
                    <Chip variant={PROMOTION_CHIP[p.status]}>{p.status}</Chip>
                  </Td>
                  <Td label="Risk">
                    {p.riskLevel ? (
                      <Chip variant={RISK_CHIP[p.riskLevel] ?? 'neutral'}>{p.riskLevel}</Chip>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td label="By" className="text-muted-foreground">
                    {p.actor ?? '—'}
                  </Td>
                  <Td label="At" className="text-muted-foreground">
                    <LocalTime epoch={p.createdAt} />
                  </Td>
                  <Td>
                    {p.status === 'pending' &&
                      p.workflowInstanceId &&
                      (isAdmin ? (
                        <ApprovalControl
                          instanceId={p.workflowInstanceId}
                          itemKey={p.key}
                          targetSlug={envSlug(p.targetEnvironmentId)}
                          highRisk={p.riskLevel === 'high'}
                          busy={busy}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          awaiting an owner or admin
                        </span>
                      ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </CardTable>
        </>
      )}
    </section>
  )
}

/** Resolving a parked promotion is irreversible in both directions — approve
 * applies to the target environment, reject closes the request. Both wear the
 * two-step confirm; approve carries the danger voice (it mutates an env). */
function ApprovalControl({
  instanceId,
  itemKey,
  targetSlug,
  highRisk,
  busy,
}: {
  instanceId: string
  itemKey: string
  targetSlug: string
  highRisk: boolean
  busy: boolean
}) {
  const [arming, setArming] = useState<'approve' | 'reject' | null>(null)
  const [typed, setTyped] = useState('')
  // High-risk approvals get ceremony proportional to blast radius: type the
  // target environment's slug to unlock the confirm.
  const locked = arming === 'approve' && highRisk && typed.trim() !== targetSlug

  if (!arming) {
    return (
      <ActionGroup>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={busy}
          onClick={() => setArming('approve')}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={busy}
          onClick={() => setArming('reject')}
        >
          Reject
        </Button>
      </ActionGroup>
    )
  }

  return (
    <div className="flex min-h-8 flex-nowrap items-center gap-2 max-sm:flex-wrap">
      <p className="m-0 text-xs text-warn">
        {arming === 'approve'
          ? highRisk
            ? `Apply "${itemKey}" to /${targetSlug}? Type the slug to confirm — there is no undo.`
            : `Apply "${itemKey}" to /${targetSlug}? There is no undo.`
          : `Reject the promotion of "${itemKey}"? Nothing is applied.`}
      </p>
      {arming === 'approve' && highRisk && (
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={targetSlug}
          aria-label={`Type ${targetSlug} to confirm`}
          className="w-32 px-2 py-1 font-mono text-xs"
        />
      )}
      <Form method="post" onSubmit={() => setArming(null)}>
        <input type="hidden" name="intent" value={arming} />
        <input type="hidden" name="instanceId" value={instanceId} />
        <Button
          type="submit"
          variant={arming === 'approve' ? 'danger' : 'secondary'}
          size="compact"
          loading={busy}
          disabled={locked}
        >
          {arming === 'approve' ? `Confirm → /${targetSlug}` : 'Confirm reject'}
        </Button>
      </Form>
      <Button type="button" variant="secondary" size="compact" onClick={() => setArming(null)}>
        Cancel
      </Button>
    </div>
  )
}
