import { Form, Link, redirect, useNavigation } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/dashboard.notifications'

/**
 * Workspace notification channels: Slack incoming webhooks + generic signed
 * webhooks. Admin-only surface (the api enforces it; this page just surfaces
 * the 403). The webhook signing secret is displayed exactly once, right after
 * creation.
 */

const EVENT_OPTIONS = [
  'config.created',
  'config.updated',
  'config.deleted',
  'config.promoted',
  'promotion.awaiting_approval',
  'secret.revealed',
] as const

type Channel = {
  id: string
  type: 'webhook' | 'slack'
  name: string
  events: string[] | null
  enabled: boolean
  createdAt: string
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Notifications · EdgeVault' }]
}

function api(env: Env, token: string, path: string, init?: RequestInit) {
  return env.API_SERVICE.fetch(`https://api/api/v1/workspaces${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  })
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const res = await api(context.cloudflare.env, token, `/${params.workspaceId}/channels`)
  if (res.status === 401) throw redirect('/login')
  if (res.status === 403) {
    return { workspaceId: params.workspaceId, channels: [] as Channel[], forbidden: true }
  }
  const channels = res.ok ? ((await res.json()) as { channels: Channel[] }).channels : []
  return { workspaceId: params.workspaceId, channels, forbidden: false }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'create') {
    const events = form.getAll('events').map(String)
    const res = await api(env, token, `/${params.workspaceId}/channels`, {
      method: 'POST',
      body: JSON.stringify({
        type: String(form.get('type')),
        name: String(form.get('name')),
        url: String(form.get('url')),
        ...(events.length ? { events } : {}),
      }),
    })
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
      return { error: detail ?? `Create failed (${res.status})` }
    }
    const created = (await res.json()) as { signingSecret?: string }
    return { created: true, signingSecret: created.signingSecret }
  }

  const channelId = String(form.get('channelId'))
  if (intent === 'delete') {
    const res = await api(env, token, `/${params.workspaceId}/channels/${channelId}`, {
      method: 'DELETE',
    })
    return res.ok ? { deleted: true } : { error: `Delete failed (${res.status})` }
  }
  if (intent === 'test') {
    const res = await api(env, token, `/${params.workspaceId}/channels/${channelId}/test`, {
      method: 'POST',
    })
    return res.ok ? { tested: true } : { error: `Test failed (${res.status})` }
  }
  return { error: 'Unknown action' }
}

export default function Notifications({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, channels, forbidden } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Notifications</p>
            <h1>{workspaceId}</h1>
          </div>
          <Link to={`/dashboard/${workspaceId}`} className="secondary button">
            ← Workspace
          </Link>
        </header>

        {forbidden && (
          <p className="error-text">Managing notification channels requires an org admin.</p>
        )}
        {actionData?.error && <p className="error-text">{actionData.error}</p>}
        {actionData?.tested && <p className="muted">Test notification queued.</p>}

        {actionData?.signingSecret && (
          <div className="token-box">
            <p className="token-note">
              Webhook signing secret — copy it now, it won't be shown again. Verify deliveries by
              recomputing HMAC-SHA256 over <code>timestamp.body</code> against{' '}
              <code>x-edgevault-signature</code>.
            </p>
            <code className="token-value">{actionData.signingSecret}</code>
          </div>
        )}

        {!forbidden && (
          <>
            <h2>Channels</h2>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Events</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel.id}>
                    <td>{channel.name}</td>
                    <td>
                      <span className="status status-equal">{channel.type}</span>
                    </td>
                    <td className="muted">
                      {channel.events?.length ? channel.events.join(', ') : 'all events'}
                    </td>
                    <td>
                      <div className="row">
                        <Form method="post">
                          <input type="hidden" name="intent" value="test" />
                          <input type="hidden" name="channelId" value={channel.id} />
                          <button type="submit" className="secondary compact" disabled={busy}>
                            Send test
                          </button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="channelId" value={channel.id} />
                          <button type="submit" className="secondary compact" disabled={busy}>
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                ))}
                {channels.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No channels yet — add Slack or a webhook below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <h2>Add a channel</h2>
            <Form method="post" className="form channel-form">
              <input type="hidden" name="intent" value="create" />
              <label>
                Type
                <select name="type" defaultValue="slack">
                  <option value="slack">Slack incoming webhook</option>
                  <option value="webhook">Generic signed webhook</option>
                </select>
              </label>
              <label>
                Name
                <input type="text" name="name" required placeholder="e.g. #deploys" />
              </label>
              <label>
                URL
                <input
                  type="url"
                  name="url"
                  required
                  placeholder="https://hooks.slack.com/services/…"
                />
              </label>
              <fieldset className="event-filter">
                <legend className="muted">Events (none checked = all)</legend>
                {EVENT_OPTIONS.map((event) => (
                  <label key={event} className="check">
                    <input type="checkbox" name="events" value={event} /> {event}
                  </label>
                ))}
              </fieldset>
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Add channel'}
              </button>
            </Form>
          </>
        )}
      </section>
    </main>
  )
}
