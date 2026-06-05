import { redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/assistant'

/**
 * BFF resource route for the workspace AI assistant (no default export → no UI).
 * It attaches the httpOnly access token server-side and proxies to the api
 * `/assistant` endpoint, which drives the AGENT durable object. The browser
 * never sees the bearer token. Consumed by the `useAgentChat` hook.
 */

/** Humans who navigate here directly get the workspace, not raw JSON — the
 * assistant lives on the dashboard. (POSTs from the chat hook hit `action`.) */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/dashboard/${params.workspaceId}`)
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let question: unknown
  try {
    question = ((await request.json()) as { question?: unknown }).question
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 })
  }
  if (typeof question !== 'string' || !question.trim()) {
    return Response.json({ error: 'empty_question' }, { status: 400 })
  }

  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/assistant`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    },
  )

  // Pass the api's status straight through (401/403/429/200) so the hook can
  // react to auth expiry and rate limits without leaking the upstream shape.
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
