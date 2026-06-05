import type { WorkspaceEvent } from '@edgevault/realtime'
import { useWorkspaceEvents } from '@edgevault/realtime/react'
import { type FormEvent, useState } from 'react'
import { Form, Link, redirect } from 'react-router'
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
  createdAt: number
}

type PromotionRow = {
  id: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  key: string
  status: 'pending' | 'completed' | 'failed'
  createdAt: number
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
  const form = await request.formData()
  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/environments`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(form.get('name') ?? '').trim(),
        slug: String(form.get('slug') ?? '').trim(),
      }),
    },
  )
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

function describeActivity(entry: ActivityEntry): string {
  return `${entry.action} · ${entry.resourceId}`
}

const PROMOTION_CHIP: Record<PromotionRow['status'], string> = {
  completed: 'status-equal',
  pending: 'status-drifted',
  failed: 'status-not-comparable',
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

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{workspaceName ?? workspaceId}</h1>
            <span className="page-id">
              {workspaceId} <CopyButton value={workspaceId} label="Copy id" />
            </span>
          </div>
          <div className="org-links">
            <Link to={`/dashboard/${workspaceId}/compare`} className="secondary button">
              Compare environments
            </Link>
            <Link to={`/dashboard/${workspaceId}/notifications`} className="secondary button">
              Notifications
            </Link>
            <Link to="/" className="secondary button">
              ← All workspaces
            </Link>
          </div>
        </header>

        <h2>Environments</h2>
        {actionData?.error && (
          <p className="error-text" role="alert">
            {actionData.error}
          </p>
        )}
        <div className="table-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Configs</th>
                <th>Flags</th>
                <th>Secrets</th>
                <th>Last change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/dashboard/${workspaceId}/env/${s.id}`}>{s.name}</Link>{' '}
                    <span className="muted mono">/{s.slug}</span>
                  </td>
                  <td className="muted">{s.configs}</td>
                  <td className="muted">{s.flags}</td>
                  <td className="muted">{s.secrets}</td>
                  <td className="muted">{s.lastChange ? formatTime(s.lastChange) : '—'}</td>
                  <td>
                    <Link
                      className="secondary button compact"
                      to={`/dashboard/${workspaceId}/env/${s.id}`}
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
              {scores.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No environments yet — create one below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <details className="create-inline">
          <summary>New environment</summary>
          <Form method="post" className="form">
            <label>
              Name
              <input type="text" name="name" required placeholder="Production" />
            </label>
            <label>
              Slug
              <input type="text" name="slug" required placeholder="production" />
            </label>
            <button type="submit">Create environment</button>
          </Form>
        </details>

        <div className="grid dash-grid">
          <div>
            <h2>Search</h2>
            <p className="muted">Semantic — find config by meaning, not key name.</p>
            <Form method="get" className="search-row">
              <input
                type="search"
                name="q"
                defaultValue={query ?? ''}
                placeholder='e.g. "the timeout we raised during the incident"'
                aria-label="Search configs"
              />
              <button type="submit">Search</button>
            </Form>
            {searchError && (
              <p className="error-text" role="alert">
                {searchError}
              </p>
            )}
            {hits && (
              <ul className="feed" aria-label="Search results">
                {hits.map((hit) => (
                  <li key={`${hit.environmentId}:${hit.key}`}>
                    <Link to={`/dashboard/${workspaceId}/env/${hit.environmentId}`}>
                      <span className="mono">{hit.key}</span>
                    </Link>{' '}
                    <span className="muted mono">
                      /{envSlug(hit.environmentId)} · {hit.kind} · {hit.score.toFixed(2)}
                    </span>
                  </li>
                ))}
                {hits.length === 0 && <li className="muted">No matches for "{query}".</li>}
              </ul>
            )}
          </div>

          <div>
            <h2>
              Activity{' '}
              <span className={`dot ${status}`} role="status">
                ● {status}
              </span>
            </h2>
            <ul className="feed">
              {events.map(({ k, e }) => (
                <li key={k} className="feed-live">
                  {describe(e)}
                </li>
              ))}
              {activity.map((entry) => (
                <li key={entry.id}>
                  {describeActivity(entry)}{' '}
                  <span className="muted feed-time">{formatTime(entry.createdAt)}</span>
                </li>
              ))}
              {events.length === 0 && activity.length === 0 && (
                <li className="muted">No changes recorded yet.</li>
              )}
            </ul>
          </div>
        </div>

        {promotions.length > 0 && (
          <>
            <h2>Recent promotions</h2>
            <div className="table-scroll">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>From → To</th>
                    <th>Status</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {promotions.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.key}</td>
                      <td className="muted mono">
                        /{envSlug(p.sourceEnvironmentId)} → /{envSlug(p.targetEnvironmentId)}
                      </td>
                      <td>
                        <span className={`status ${PROMOTION_CHIP[p.status]}`}>{p.status}</span>
                      </td>
                      <td className="muted">{formatTime(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <Assistant workspaceId={workspaceId} />
      </section>
    </main>
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
      <p className="muted">Ask what changed in this workspace and why.</p>
      <ul className="chat">
        {messages.map((m) => (
          <li key={m.id} className={`chat-msg ${m.role}`}>
            <span className="role">{m.role === 'user' ? 'You' : 'Agent'}</span>
            <span className="content">{m.content}</span>
            {m.role === 'assistant' && m.source === 'fallback' && (
              <span className="muted tag"> (offline summary)</span>
            )}
          </li>
        ))}
        {messages.length === 0 && <li className="muted">No questions yet.</li>}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
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
