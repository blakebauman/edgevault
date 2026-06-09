import { ActionGroup, Button, ErrorNote, TokenBox, TokenValue, TwoStepConfirm } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/scim'

/**
 * Org SCIM provisioning. Owner/admins generate (or rotate) the bearer token an
 * IdP uses to call EdgeVault's SCIM endpoints. The raw token is returned by the
 * api exactly once — we surface it here and never store it — only its hash lives
 * server-side. The api enforces the real RBAC; this is the UI.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'SCIM provisioning · EdgeVault' }]
}

interface Org {
  id: string
  name: string
  slug: string
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401 || res.status === 403) throw redirect('/login')

  const organizations = res.ok ? ((await res.json()) as { organizations: Org[] }).organizations : []
  const org = organizations.find((o) => o.id === params.orgId)
  // Not a member (or no such org) — don't reveal anything; bounce home.
  if (!org) throw redirect('/')

  // Token status: a boolean only (configured), never the value.
  const statusRes = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/scim-token`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  const status = statusRes.ok
    ? ((await statusRes.json()) as { configured: boolean })
    : { configured: false }
  return { org, status }
}

/** Map api status codes to a human message for the SCIM token endpoints. */
function messageForStatus(status: number): string {
  if (status === 403) return 'Only organization owners or admins can manage SCIM tokens.'
  if (status === 401) return 'Your session expired. Please sign in again.'
  return 'Something went wrong. Please try again.'
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent') ?? 'generate')
  const url = `https://api/api/v1/organizations/${params.orgId}/scim-token`

  if (intent === 'revoke') {
    const res = await env.API_SERVICE.fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { error: messageForStatus(res.status) }
    return { revoked: true as const }
  }

  // generate / rotate
  const res = await env.API_SERVICE.fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { error: messageForStatus(res.status) }
  const { token: scimToken } = (await res.json()) as { token: string }
  return { scimToken }
}

export default function Scim({ loaderData, actionData }: Route.ComponentProps) {
  const { org, status } = loaderData
  const scimToken = actionData && 'scimToken' in actionData ? actionData.scimToken : null
  const revoked = actionData && 'revoked' in actionData ? actionData.revoked : false
  const error = actionData && 'error' in actionData ? actionData.error : null

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">SCIM provisioning</p>
            <h1>{org.name}</h1>
          </div>
          <Button variant="secondary" asChild>
            <Link to="/">← All workspaces</Link>
          </Button>
        </header>

        <p className="lede">
          Generate a bearer token for your identity provider (Okta, Entra ID, …) to provision users
          into this organization over SCIM 2.0. Paste it into your IdP’s SCIM connector as the
          secret token.
        </p>

        {error && <ErrorNote>{error}</ErrorNote>}

        {scimToken ? (
          <TokenBox
            note={
              <>
                Copy this now — it is shown <strong>only once</strong> and cannot be retrieved
                later.
              </>
            }
          >
            <TokenValue>{scimToken}</TokenValue>
          </TokenBox>
        ) : revoked ? (
          <p className="text-muted-foreground">
            The SCIM token has been revoked. Existing IdP syncs will now fail.
          </p>
        ) : (
          <p className="text-muted-foreground">
            {status.configured
              ? 'A SCIM token is configured for this organization. Rotate it to issue a new one.'
              : 'No SCIM token has been generated yet.'}
          </p>
        )}

        <ActionGroup className="mt-6">
          <Form method="post">
            <Button type="submit" name="intent" value="generate">
              {status.configured ? 'Rotate token' : 'Generate token'}
            </Button>
          </Form>
          {status.configured && (
            <TwoStepConfirm
              trigger="Revoke token"
              note="Provisioning stops until a new token is configured in your IdP."
            >
              {(close) => (
                <Form method="post" onSubmit={close}>
                  <Button
                    type="submit"
                    name="intent"
                    value="revoke"
                    variant="danger"
                    size="compact"
                  >
                    Confirm revoke
                  </Button>
                </Form>
              )}
            </TwoStepConfirm>
          )}
        </ActionGroup>

        <p className="mt-4 text-sm text-muted-foreground">
          Generating a new token immediately invalidates the previous one.
        </p>
      </section>
    </main>
  )
}
