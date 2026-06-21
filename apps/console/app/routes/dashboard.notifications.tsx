import {
  ActionGroup,
  Button,
  CardTable,
  Checkbox,
  Chip,
  ErrorNote,
  Field,
  Input,
  Select,
  StatusNote,
  Td,
  Th,
  TokenBox,
  TokenValue,
  TwoStepConfirm,
} from '@edgevault/ui'
import { Form, redirect, useNavigation } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import { getWorkspaceName } from '../lib/workspace.server'
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

  const [res, workspaceName] = await Promise.all([
    api(context.cloudflare.env, token, `/${params.workspaceId}/channels`),
    getWorkspaceName(context.cloudflare.env, token, params.workspaceId),
  ])
  if (res.status === 401) throw redirect('/login')
  if (res.status === 403) {
    return {
      workspaceId: params.workspaceId,
      workspaceName,
      channels: [] as Channel[],
      forbidden: true,
    }
  }
  const channels = res.ok ? ((await res.json()) as { channels: Channel[] }).channels : []
  return { workspaceId: params.workspaceId, workspaceName, channels, forbidden: false }
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
      return { error: detail ?? friendlyError(res.status, 'creating the channel') }
    }
    const created = (await res.json()) as { signingSecret?: string }
    return { created: true, signingSecret: created.signingSecret }
  }

  const channelId = String(form.get('channelId'))
  if (intent === 'delete') {
    const res = await api(env, token, `/${params.workspaceId}/channels/${channelId}`, {
      method: 'DELETE',
    })
    return res.ok ? { deleted: true } : { error: friendlyError(res.status, 'deleting the channel') }
  }
  if (intent === 'test') {
    const res = await api(env, token, `/${params.workspaceId}/channels/${channelId}/test`, {
      method: 'POST',
    })
    return res.ok
      ? { tested: true }
      : { error: friendlyError(res.status, 'sending the test event') }
  }
  return { error: 'Unknown action' }
}

export default function Notifications({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, channels, forbidden } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Notifications</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
      </header>

      {forbidden && <ErrorNote>Managing notification channels requires an org admin.</ErrorNote>}
      {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
      {actionData?.tested && <StatusNote>Test notification queued.</StatusNote>}
      {actionData?.deleted && <StatusNote>Channel deleted.</StatusNote>}

      {actionData?.signingSecret && (
        <TokenBox
          note={
            <>
              Webhook signing secret — copy it now, it won't be shown again. Verify deliveries by
              recomputing HMAC-SHA256 over <code>timestamp.body</code> against{' '}
              <code>x-edgevault-signature</code>.
            </>
          }
        >
          <TokenValue>{actionData.signingSecret}</TokenValue>
          <CopyButton value={actionData.signingSecret} label="Copy secret" />
        </TokenBox>
      )}

      {!forbidden && (
        <>
          <h2>Channels</h2>
          <CardTable label="Notification channels">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Events</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <Td label="Name">{channel.name}</Td>
                  <Td label="Type">
                    <Chip variant="neutral">{channel.type}</Chip>
                  </Td>
                  <Td label="Events" className="text-muted-foreground">
                    {channel.events?.length ? channel.events.join(', ') : 'all events'}
                  </Td>
                  <Td>
                    <ActionGroup>
                      <Form method="post">
                        <input type="hidden" name="intent" value="test" />
                        <input type="hidden" name="channelId" value={channel.id} />
                        <Button type="submit" variant="secondary" size="compact" disabled={busy}>
                          Send test
                        </Button>
                      </Form>
                      <DeleteChannel channelId={channel.id} name={channel.name} busy={busy} />
                    </ActionGroup>
                  </Td>
                </tr>
              ))}
              {channels.length === 0 && (
                <tr>
                  <Td colSpan={4} className="py-10 text-center text-muted-foreground">
                    No channels yet — add Slack or a webhook below.
                  </Td>
                </tr>
              )}
            </tbody>
          </CardTable>

          <h2>Add a channel</h2>
          <Form method="post" className="mt-6 flex max-w-md flex-col gap-3">
            <input type="hidden" name="intent" value="create" />
            <Field label="Type">
              <Select name="type" defaultValue="slack">
                <option value="slack">Slack incoming webhook</option>
                <option value="webhook">Generic signed webhook</option>
              </Select>
            </Field>
            <Field label="Name">
              <Input type="text" name="name" required placeholder="e.g. #deploys" />
            </Field>
            <Field label="URL">
              <Input
                type="url"
                name="url"
                required
                placeholder="https://hooks.slack.com/services/…"
              />
            </Field>
            <fieldset className="grid gap-1.5 rounded-sm border border-input p-3">
              <legend className="text-muted-foreground">Events to deliver</legend>
              <p className="field-hint">Leave every box unchecked to deliver all event types.</p>
              {EVENT_OPTIONS.map((event) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders a native input inside the label
                <label key={event} className="flex items-center gap-2 font-mono text-xs">
                  <Checkbox name="events" value={event} /> {event}
                </label>
              ))}
            </fieldset>
            <Button type="submit" className="self-start" disabled={busy}>
              {busy ? 'Saving…' : 'Add channel'}
            </Button>
          </Form>
        </>
      )}
    </section>
  )
}

/** Channel deletion is unrecoverable — two-step inline confirm. */
function DeleteChannel({
  channelId,
  name,
  busy,
}: {
  channelId: string
  name: string
  busy: boolean
}) {
  return (
    <TwoStepConfirm
      trigger="Delete"
      note={`Delete "${name}"? This cannot be undone.`}
      disabled={busy}
    >
      {(close) => (
        <Form method="post" onSubmit={close}>
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="channelId" value={channelId} />
          <Button type="submit" variant="danger" size="compact" disabled={busy}>
            Confirm delete
          </Button>
        </Form>
      )}
    </TwoStepConfirm>
  )
}
