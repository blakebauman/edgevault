import type { WorkspaceEvent } from '@edgevault/realtime'
import { useWorkspaceEvents } from '@edgevault/realtime/react'
import { useState } from 'react'
import { Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/dashboard'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Workspace · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/environments`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (res.status === 401 || res.status === 403) throw redirect('/login')
  const environments = res.ok
    ? ((await res.json()) as { environments: Array<{ id: string; name: string; slug: string }> })
        .environments
    : []

  return {
    workspaceId: params.workspaceId,
    environments,
    // The browser connects directly to the api WebSocket with the short-lived token.
    wsUrl: `${env.API_WS_BASE}/api/v1/workspaces/${params.workspaceId}/ws?token=${encodeURIComponent(token)}`,
  }
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

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { environments, wsUrl, workspaceId } = loaderData
  const [events, setEvents] = useState<Array<{ k: string; e: WorkspaceEvent }>>([])
  const status = useWorkspaceEvents(wsUrl, (event) =>
    setEvents((prev) => [{ k: crypto.randomUUID(), e: event }, ...prev].slice(0, 50)),
  )

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{workspaceId}</h1>
          </div>
          <Link to="/" className="secondary button">
            ← All workspaces
          </Link>
        </header>

        <div className="grid">
          <div>
            <h2>Environments</h2>
            <ul className="ws-list">
              {environments.map((e) => (
                <li key={e.id}>
                  {e.name} <span className="muted">/{e.slug}</span>
                </li>
              ))}
              {environments.length === 0 && <li className="muted">No environments yet</li>}
            </ul>
          </div>

          <div>
            <h2>
              Live activity <span className={`dot ${status}`}>● {status}</span>
            </h2>
            <ul className="feed">
              {events.map(({ k, e }) => (
                <li key={k}>{describe(e)}</li>
              ))}
              {events.length === 0 && <li className="muted">Waiting for changes…</li>}
            </ul>
          </div>
        </div>
      </section>
    </main>
  )
}
