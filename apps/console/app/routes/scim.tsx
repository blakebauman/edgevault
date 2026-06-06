import { ActionGroup, Button, ErrorNote, TokenBox, TokenValue } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/scim'

/**
 * Org SCIM provisioning. Owner/admins generate (or rotate) the bearer token an
 * IdP uses to call EdgeVault's SCIM endpoints. The raw token is returned by the
 * api exactly once — we surface it here and never store it — only its hash lives
 * server-side. The api enforces the real RBAC + entitlement gate; this is the UI.
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

  // Token status: booleans only (entitled / configured), never the value.
  const statusRes = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/scim-token`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  const status = statusRes.ok
    ? ((await statusRes.json()) as { entitled: boolean; configured: boolean })
    : { entitled: false, configured: false }
  return { org, status }
}

/** Map api status codes to a human message for the SCIM token endpoints. */
function messageForStatus(status: number): string {
  if (status === 402) return 'This organization’s plan does not include SCIM provisioning.'
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

        {!status.entitled && (
          <ErrorNote>
            This organization’s plan does not include SCIM provisioning. Upgrade to enable it.
          </ErrorNote>
        )}

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
        ) : status.entitled ? (
          <p className="text-muted-foreground">
            {status.configured
              ? 'A SCIM token is configured for this organization. Rotate it to issue a new one.'
              : 'No SCIM token has been generated yet.'}
          </p>
        ) : null}

        <ActionGroup className="mt-6">
          <Form method="post">
            <Button type="submit" name="intent" value="generate" disabled={!status.entitled}>
              {status.configured ? 'Rotate token' : 'Generate token'}
            </Button>
          </Form>
          {status.configured && (
            <Form method="post">
              <Button type="submit" name="intent" value="revoke" variant="secondary">
                Revoke token
              </Button>
            </Form>
          )}
        </ActionGroup>

        <p className="mt-4 text-sm text-muted-foreground">
          Generating a new token immediately invalidates the previous one.
        </p>
      </section>
    </main>
  )
}
