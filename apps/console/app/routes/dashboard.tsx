import type { WorkspaceEvent } from '@edgevault/realtime'
import { useWorkspaceEvents } from '@edgevault/realtime/react'
import {
  ActionGroup,
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  ErrorNote,
  Field,
  Input,
  StatusNote,
  Td,
  Th,
} from '@edgevault/ui'
import { type FormEvent, useState } from 'react'
import { Form, Link, redirect, useNavigation } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { formatTime } from '../lib/format'
import { getToken } from '../lib/session.server'
import { useAgentChat } from '../lib/use-agent-chat'
import { getWorkspaceName } from '../lib/workspace.server'
import type { Route } from './+types/dashboard'

/**
 * The workspace dashboard: a box-score of every environment (counts by kind,
 * last change), semantic search over the workspace's configs, the activity
 * history with live events streaming on top, recent promotions, and the
 * assistant. Density is the point — this is a data product.
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

  const [workspaceName, envsRes, activityRes, promotionsRes, searchRes] = await Promise.all([
    getWorkspaceName(env, token, params.workspaceId),
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
    else searchError = `Search is unavailable right now (${searchRes.status}).`
  }

  return {
    workspaceId: params.workspaceId,
    workspaceName,
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
  const intent = String(form.get('intent') ?? 'create-env')

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
    if (!res.ok) return { error: `Could not ${intent} the promotion (${res.status}).` }
    return intent === 'approve' ? { approved: true } : { rejected: true }
  }

  const res = await env.API_SERVICE.fetch(`${base}/environments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: String(form.get('name') ?? '').trim(),
      slug: String(form.get('slug') ?? '').trim(),
    }),
  })
  if (!res.ok) return { error: `Could not create the environment (${res.status}).` }
  return { created: true }
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
  return `${entry.action} · ${resource}`
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

export default function Dashboard({ loaderData, actionData }: Route.ComponentProps) {
  const {
    scores,
    activity,
    promotions,
    query,
    hits,
    searchError,
    wsUrl,
    workspaceId,
    workspaceName,
  } = loaderData
  const [events, setEvents] = useState<Array<{ k: string; e: WorkspaceEvent }>>([])
  const status = useWorkspaceEvents(wsUrl, (event) =>
    setEvents((prev) => [{ k: crypto.randomUUID(), e: event }, ...prev].slice(0, 20)),
  )
  const envSlug = (id: string) => scores.find((s) => s.id === id)?.slug ?? id.slice(0, 8)
  const busy = useNavigation().state !== 'idle'

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{workspaceName ?? workspaceId}</h1>
            <span className="page-id">
              <CopyButton value={workspaceId} label="Copy workspace id" />
            </span>
          </div>
          <div className="org-links">
            <Button variant="secondary" asChild>
              <Link to={`/dashboard/${workspaceId}/compare`}>Compare environments</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to={`/dashboard/${workspaceId}/audit`}>Audit history</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to={`/dashboard/${workspaceId}/notifications`}>Notifications</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/">← All workspaces</Link>
            </Button>
          </div>
        </header>

        {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
        {actionData && 'approved' in actionData && (
          <StatusNote>
            Approved — the workflow is applying the snapshotted value and verifying the edge
            read-back now.
          </StatusNote>
        )}
        {actionData && 'rejected' in actionData && (
          <StatusNote>Rejected — the promotion is closed; nothing was applied.</StatusNote>
        )}

        <h2>Environments</h2>
        <CardTable label="Environments">
          <thead>
            <tr>
              <Th>Environment</Th>
              <Th>Configs</Th>
              <Th>Flags</Th>
              <Th>Secrets</Th>
              <Th>Last change</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {scores.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link to={`/dashboard/${workspaceId}/env/${s.id}`}>{s.name}</Link>{' '}
                  <span className="font-mono text-sm text-muted-foreground">/{s.slug}</span>
                </Td>
                <Td label="Configs" className="text-muted-foreground">
                  {s.configs}
                </Td>
                <Td label="Flags" className="text-muted-foreground">
                  {s.flags}
                </Td>
                <Td label="Secrets" className="text-muted-foreground">
                  {s.secrets}
                </Td>
                <Td label="Last change" className="text-muted-foreground">
                  {s.lastChange ? formatTime(s.lastChange) : '—'}
                </Td>
                <Td>
                  <Button variant="secondary" size="compact" asChild>
                    <Link to={`/dashboard/${workspaceId}/env/${s.id}`}>Open →</Link>
                  </Button>
                </Td>
              </tr>
            ))}
            {scores.length === 0 && (
              <tr>
                <Td colSpan={6} className="text-muted-foreground">
                  No environments yet — create one below.
                </Td>
              </tr>
            )}
          </tbody>
        </CardTable>
        <details className="create-inline">
          <summary>New environment</summary>
          <Form method="post" className="mt-6 flex max-w-xs flex-col gap-3">
            <input type="hidden" name="intent" value="create-env" />
            <Field label="Name">
              <Input type="text" name="name" required placeholder="Production" />
            </Field>
            <Field label="Slug">
              <Input type="text" name="slug" required placeholder="production" />
            </Field>
            <Button type="submit" className="self-start">
              Create environment
            </Button>
          </Form>
        </details>

        <div className="grid dash-grid">
          <div>
            <h2>Search</h2>
            <p className="mb-2 text-sm text-muted-foreground">
              Semantic — find config by meaning, not key name.
            </p>
            <Form method="get" className="my-2 flex gap-2">
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
                    <Link to={`/dashboard/${workspaceId}/env/${hit.environmentId}`}>
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

          <div>
            <h2>
              Activity{' '}
              <span className={`dot ${status}`} role="status">
                <span aria-hidden="true">● </span>
                {status}
              </span>
            </h2>
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
                    {formatTime(entry.createdAt)}
                  </span>
                </li>
              ))}
              {events.length === 0 && activity.length === 0 && (
                <li className="text-muted-foreground">No changes recorded yet.</li>
              )}
            </ul>
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
                      {formatTime(p.createdAt)}
                    </Td>
                    <Td>
                      {p.status === 'pending' && p.workflowInstanceId && (
                        <ApprovalControl
                          instanceId={p.workflowInstanceId}
                          itemKey={p.key}
                          targetSlug={envSlug(p.targetEnvironmentId)}
                          busy={busy}
                        />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </CardTable>
          </>
        )}

        <Assistant workspaceId={workspaceId} />
      </section>
    </main>
  )
}

/** Resolving a parked promotion is irreversible in both directions — approve
 * applies to the target environment, reject closes the request. Both wear the
 * two-step confirm; approve carries the danger voice (it mutates an env). */
function ApprovalControl({
  instanceId,
  itemKey,
  targetSlug,
  busy,
}: {
  instanceId: string
  itemKey: string
  targetSlug: string
  busy: boolean
}) {
  const [arming, setArming] = useState<'approve' | 'reject' | null>(null)

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
          ? `Apply "${itemKey}" to /${targetSlug}? There is no undo.`
          : `Reject the promotion of "${itemKey}"? Nothing is applied.`}
      </p>
      <Form method="post" onSubmit={() => setArming(null)}>
        <input type="hidden" name="intent" value={arming} />
        <input type="hidden" name="instanceId" value={instanceId} />
        <Button
          type="submit"
          variant={arming === 'approve' ? 'danger' : 'secondary'}
          size="compact"
          disabled={busy}
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

function Assistant({ workspaceId }: { workspaceId: string }) {
  const { messages, isLoading, error, send } = useAgentChat(workspaceId)
  const [input, setInput] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const q = input
    setInput('')
    await send(q)
  }

  return (
    <div className="assistant">
      <h2>Assistant</h2>
      <p className="m-0 text-sm text-muted-foreground">
        Ask what changed in this workspace and why.
      </p>
      <ul className="chat">
        {messages.map((m) => (
          <li key={m.id} className={`chat-msg ${m.role}`}>
            <span className="role">{m.role === 'user' ? 'You' : 'Agent'}</span>
            <span className="content">{m.content}</span>
            {m.role === 'assistant' && m.source === 'fallback' && (
              <span className="text-xs text-muted-foreground"> (offline summary)</span>
            )}
          </li>
        ))}
        {messages.length === 0 && <li className="text-muted-foreground">No questions yet.</li>}
      </ul>
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. what changed recently?"
          disabled={isLoading}
          aria-label="Ask the assistant"
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          {isLoading ? 'Thinking…' : 'Ask'}
        </button>
      </form>
    </div>
  )
}
