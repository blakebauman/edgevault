import { Button, ErrorNote, Field, Input, TokenBox, TokenValue } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { Forbidden } from '../components/forbidden'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/sso-admin'

/**
 * Org enterprise-SSO (OIDC) admin. Owner/admins register the IdP connection
 * (issuer, client id/secret, redirect URI). The console enforces the owner/admin
 * check here because the auth worker's SSO connection endpoints trust this BFF
 * (INTERNAL_TOKEN); the client secret is write-only and never returned.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Enterprise SSO · EdgeVault' }]
}

interface Org {
  id: string
  name: string
  slug: string
  role: string
}

interface ConnectionView {
  configured: boolean
  issuer?: string
  clientId?: string
  redirectUri?: string
  scopes?: string[]
}

const ADMIN_ROLES = new Set(['owner', 'admin'])

async function requireOrgAdmin(token: string, orgId: string, env: Env): Promise<Org> {
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401 || res.status === 403) throw redirect('/login')
  const organizations = res.ok ? ((await res.json()) as { organizations: Org[] }).organizations : []
  const org = organizations.find((o) => o.id === orgId)
  if (!org) throw redirect('/') // not a member — reveal nothing
  return org
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const org = await requireOrgAdmin(token, params.orgId, env)

  const isAdmin = ADMIN_ROLES.has(org.role)
  const suggestedRedirectUri = `${new URL(request.url).origin}/sso/${params.orgId}/callback`

  let connection: ConnectionView = { configured: false }
  if (isAdmin) {
    const res = await env.AUTH_SERVICE.fetch(`https://auth/orgs/${params.orgId}/sso/connection`, {
      headers: { 'x-internal-token': env.INTERNAL_TOKEN },
    })
    if (res.ok) connection = (await res.json()) as ConnectionView
    // 404 → not configured yet (default connection above)
  }

  return { org, isAdmin, connection, suggestedRedirectUri }
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) return 'You are not allowed to manage SSO for this org.'
  if (status === 400) return 'Please fill in the issuer, client ID, secret, and redirect URI.'
  return 'Something went wrong. Please try again.'
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const org = await requireOrgAdmin(token, params.orgId, env)
  if (!ADMIN_ROLES.has(org.role)) return { error: 'Only owners or admins can configure SSO.' }

  const form = await request.formData()
  const scopesRaw = String(form.get('scopes') ?? '').trim()
  const body = {
    issuer: String(form.get('issuer') ?? '').trim(),
    clientId: String(form.get('clientId') ?? '').trim(),
    clientSecret: String(form.get('clientSecret') ?? ''),
    redirectUri: String(form.get('redirectUri') ?? '').trim(),
    scopes: scopesRaw ? scopesRaw.split(/\s+/) : undefined,
  }

  const res = await env.AUTH_SERVICE.fetch(`https://auth/orgs/${params.orgId}/sso/connection`, {
    method: 'PUT',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { error: messageForStatus(res.status) }
  return { saved: true as const }
}

export default function SsoAdmin({ loaderData, actionData }: Route.ComponentProps) {
  const { org, isAdmin, connection, suggestedRedirectUri } = loaderData
  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : false

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Enterprise SSO (OIDC)</p>
            <h1>{org.name}</h1>
          </div>
          <Button variant="secondary" asChild>
            <Link to="/">← All workspaces</Link>
          </Button>
        </header>

        {!isAdmin && <Forbidden subject="configure SSO" />}

        {isAdmin && (
          <>
            <p className="lede">
              Connect your identity provider (Okta, Entra ID, Google Workspace). Set your IdP’s
              redirect / callback URL to the value below, then save the connection here.
            </p>
            {saved && (
              <p className="text-muted-foreground">
                Connection saved. Members can now sign in via SSO.
              </p>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            {connection.configured && (
              <p className="text-muted-foreground">
                A connection is configured for <code>{connection.issuer}</code>. Re-saving rotates
                the stored client secret.
              </p>
            )}

            <TokenBox note="Redirect URI (set this in your IdP):">
              <TokenValue>{suggestedRedirectUri}</TokenValue>
            </TokenBox>

            <Form method="post" className="mt-6 flex max-w-md flex-col gap-3 stack-gap">
              <Field label="Issuer URL">
                <Input
                  name="issuer"
                  type="url"
                  placeholder="https://example.okta.com"
                  defaultValue={connection.issuer ?? ''}
                  required
                />
              </Field>
              <Field label="Client ID">
                <Input name="clientId" defaultValue={connection.clientId ?? ''} required />
              </Field>
              <Field
                label={<>Client secret {connection.configured && '(re-enter to save changes)'}</>}
              >
                <Input name="clientSecret" type="password" required />
              </Field>
              <Field label="Redirect URI">
                <Input
                  name="redirectUri"
                  type="url"
                  defaultValue={connection.redirectUri ?? suggestedRedirectUri}
                  required
                />
              </Field>
              <Field label="Scopes (space-separated)">
                <Input
                  name="scopes"
                  defaultValue={(connection.scopes ?? ['openid', 'email', 'profile']).join(' ')}
                />
              </Field>
              <Button type="submit" className="self-start">
                {connection.configured ? 'Update connection' : 'Save connection'}
              </Button>
            </Form>
          </>
        )}
      </section>
    </main>
  )
}
