import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/sso-admin'

/**
 * Org enterprise-SSO (OIDC) admin. Owner/admins register the IdP connection
 * (issuer, client id/secret, redirect URI). The console enforces the owner/admin
 * check here because the ee/enterprise connection endpoints trust this BFF
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
  const ssoAvailable = Boolean(env.ENTERPRISE_SERVICE)

  let connection: ConnectionView = { configured: false }
  let entitled = true
  if (isAdmin && ssoAvailable) {
    const res = await env.ENTERPRISE_SERVICE.fetch(
      `https://enterprise/orgs/${params.orgId}/sso/connection`,
      { headers: { 'x-internal-token': env.INTERNAL_TOKEN } },
    )
    if (res.status === 402) entitled = false
    else if (res.ok) connection = (await res.json()) as ConnectionView
    // 404 → not configured yet (default connection above)
  }

  return { org, isAdmin, ssoAvailable, entitled, connection, suggestedRedirectUri }
}

function messageForStatus(status: number): string {
  if (status === 402) return 'This organization’s plan does not include enterprise SSO.'
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
  if (!env.ENTERPRISE_SERVICE)
    return { error: 'Enterprise SSO is not enabled for this deployment.' }

  const form = await request.formData()
  const scopesRaw = String(form.get('scopes') ?? '').trim()
  const body = {
    issuer: String(form.get('issuer') ?? '').trim(),
    clientId: String(form.get('clientId') ?? '').trim(),
    clientSecret: String(form.get('clientSecret') ?? ''),
    redirectUri: String(form.get('redirectUri') ?? '').trim(),
    scopes: scopesRaw ? scopesRaw.split(/\s+/) : undefined,
  }

  const res = await env.ENTERPRISE_SERVICE.fetch(
    `https://enterprise/orgs/${params.orgId}/sso/connection`,
    {
      method: 'PUT',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) return { error: messageForStatus(res.status) }
  return { saved: true as const }
}

export default function SsoAdmin({ loaderData, actionData }: Route.ComponentProps) {
  const { org, isAdmin, ssoAvailable, entitled, connection, suggestedRedirectUri } = loaderData
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
          <Link to="/" className="secondary button">
            ← All workspaces
          </Link>
        </header>

        {!isAdmin && (
          <p className="error-text">Only organization owners or admins can configure SSO.</p>
        )}
        {isAdmin && !ssoAvailable && (
          <p className="error-text">Enterprise SSO is not enabled for this deployment.</p>
        )}
        {isAdmin && ssoAvailable && !entitled && (
          <p className="error-text">
            This organization’s plan does not include enterprise SSO. Upgrade to enable it.
          </p>
        )}

        {isAdmin && ssoAvailable && entitled && (
          <>
            <p className="lede">
              Connect your identity provider (Okta, Entra ID, Google Workspace). Set your IdP’s
              redirect / callback URL to the value below, then save the connection here.
            </p>
            {saved && <p className="muted">Connection saved. Members can now sign in via SSO.</p>}
            {error && <p className="error-text">{error}</p>}
            {connection.configured && (
              <p className="muted">
                A connection is configured for <code>{connection.issuer}</code>. Re-saving rotates
                the stored client secret.
              </p>
            )}

            <div className="token-box">
              <p className="token-note">Redirect URI (set this in your IdP):</p>
              <code className="token-value">{suggestedRedirectUri}</code>
            </div>

            <Form method="post" className="form" style={{ marginTop: '1.5rem' }}>
              <label>
                Issuer URL
                <input
                  name="issuer"
                  type="url"
                  placeholder="https://example.okta.com"
                  defaultValue={connection.issuer ?? ''}
                  required
                />
              </label>
              <label>
                Client ID
                <input name="clientId" defaultValue={connection.clientId ?? ''} required />
              </label>
              <label>
                Client secret {connection.configured && '(re-enter to save changes)'}
                <input name="clientSecret" type="password" required />
              </label>
              <label>
                Redirect URI
                <input
                  name="redirectUri"
                  type="url"
                  defaultValue={connection.redirectUri ?? suggestedRedirectUri}
                  required
                />
              </label>
              <label>
                Scopes (space-separated)
                <input
                  name="scopes"
                  defaultValue={(connection.scopes ?? ['openid', 'email', 'profile']).join(' ')}
                />
              </label>
              <div className="row">
                <button type="submit">
                  {connection.configured ? 'Update connection' : 'Save connection'}
                </button>
              </div>
            </Form>
          </>
        )}
      </section>
    </main>
  )
}
