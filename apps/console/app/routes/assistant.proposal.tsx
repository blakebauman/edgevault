import { cloudflareContext } from '../lib/cloudflare'
import { api } from '../lib/items.server'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/assistant.proposal'

/**
 * BFF resource route behind the assistant's proposal cards.
 *
 * `loader` reconciles a proposal against the live item so a card in old chat
 * history reports "Applied" instead of offering to redo work. `action` applies
 * one.
 *
 * The apply path deliberately calls the same control-plane endpoints the config
 * screens post to, with the user's own session token. There is no assistant
 * write path: role checks, step-up policy, revision history, audit,
 * notifications, KV write-through and Vectorize indexing all happen exactly as
 * they do for a hand-typed edit, because it is the same request. The agent's
 * Durable Object never writes and never sees a credential.
 */

type ItemState = { exists: boolean; version?: number; content?: string }

async function readItem(
  env: Env,
  token: string,
  workspaceId: string,
  environmentId: string,
  key: string,
): Promise<ItemState> {
  const res = await api(
    env,
    token,
    `/${workspaceId}/environments/${environmentId}/configs/${encodeURIComponent(key)}`,
  )
  if (!res.ok) return { exists: false }
  const body = (await res.json().catch(() => null)) as {
    config?: { version: number; content: string }
  } | null
  const config = body?.config
  return config
    ? { exists: true, version: config.version, content: config.content }
    : { exists: false }
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const environmentId = url.searchParams.get('environmentId') ?? ''
  const key = url.searchParams.get('key') ?? ''
  if (!environmentId || !key) return Response.json({ error: 'missing_params' }, { status: 400 })

  const current = await readItem(env, token, params.workspaceId, environmentId, key)
  return Response.json(current)
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return Response.json({ error: 'bad_request' }, { status: 400 })
  const workspaceId = params.workspaceId

  if (body.kind === 'config-change') {
    const res = await api(
      env,
      token,
      `/${workspaceId}/environments/${body.environmentId}/configs`,
      {
        method: 'POST',
        body: JSON.stringify({
          key: body.key,
          kind: body.itemKind,
          content: body.content,
          contentType: body.contentType ?? 'json',
          summary: 'Applied from an assistant proposal',
        }),
      },
    )
    if (!res.ok) return Response.json(await failure(res), { status: res.status })
    const { config } = (await res.json()) as { config: { version: number } }
    return Response.json({ applied: true, version: config.version })
  }

  if (body.kind === 'promotion') {
    const res = await api(env, token, `/${workspaceId}/promotions`, {
      method: 'POST',
      body: JSON.stringify({
        sourceEnvironmentId: body.sourceEnvironmentId,
        targetEnvironmentId: body.targetEnvironmentId,
        key: body.key,
      }),
    })
    if (!res.ok) return Response.json(await failure(res), { status: res.status })
    return Response.json({ applied: true })
  }

  return Response.json({ error: 'unsupported_kind' }, { status: 400 })
}

/** Surface the control plane's own reason where it gave one. */
async function failure(res: Response): Promise<{ error: string }> {
  const body = (await res.json().catch(() => null)) as {
    detail?: string
    error?: string
  } | null
  if (res.status === 403) {
    return { error: body?.detail ?? 'Your role does not allow this change.' }
  }
  return { error: body?.detail ?? body?.error ?? `Could not apply the change (${res.status}).` }
}
