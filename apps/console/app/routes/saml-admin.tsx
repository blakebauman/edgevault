import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/saml-admin'

/**
 * Org enterprise-SSO (SAML 2.0) admin. Owner/admins register the IdP connection
 * (entity id, SSO URL, signing certificate) and see the SP values to enter at the
 * IdP. The console enforces the owner/admin check; the IdP certificate is public.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Enterprise SSO (SAML) · EdgeVault' }]
}

interface Org {
  id: string
  name: string
  slug: string
  role: string
}

interface ConnectionView {
  configured: boolean
  idpEntityId?: string
  idpSsoUrl?: string
  spEntityId?: string
  acsUrl?: string
}

const ADMIN_ROLES = new Set(['owner', 'admin'])

async function requireOrgAdmin(token: string, orgId: string, env: Env): Promise<Org> {
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401 || res.status === 403) throw redirect('/login')
  const organizations = res.ok ? ((await res.json()) as { organizations: Org[] }).organizations : []
  const org = organizations.find((o) => o.id === orgId)
  if (!org) throw redirect('/')
  return org
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const org = await requireOrgAdmin(token, params.orgId, env)

  const isAdmin = ADMIN_ROLES.has(org.role)
  const origin = new URL(request.url).origin
  const suggestedAcsUrl = `${origin}/saml/${params.orgId}/acs`
  const suggestedSpEntityId = `${origin}/saml/${params.orgId}/metadata`
  const ssoAvailable = Boolean(env.ENTERPRISE_SERVICE)

  let connection: ConnectionView = { configured: false }
  let entitled = true
  if (isAdmin && ssoAvailable) {
    const res = await env.ENTERPRISE_SERVICE.fetch(
      `https://enterprise/orgs/${params.orgId}/saml/connection`,
      { headers: { 'x-internal-token': env.INTERNAL_TOKEN } },
    )
    if (res.status === 402) entitled = false
    else if (res.ok) connection = (await res.json()) as ConnectionView
  }

  return { org, isAdmin, ssoAvailable, entitled, connection, suggestedAcsUrl, suggestedSpEntityId }
}

function messageForStatus(status: number): string {
  if (status === 402) return 'This organization’s plan does not include enterprise SSO.'
  if (status === 401 || status === 403) return 'You are not allowed to manage SSO for this org.'
  if (status === 400) return 'Please fill in every field.'
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
  const body = {
    idpEntityId: String(form.get('idpEntityId') ?? '').trim(),
    idpSsoUrl: String(form.get('idpSsoUrl') ?? '').trim(),
    idpCertificate: String(form.get('idpCertificate') ?? '').trim(),
    spEntityId: String(form.get('spEntityId') ?? '').trim(),
    acsUrl: String(form.get('acsUrl') ?? '').trim(),
  }

  const res = await env.ENTERPRISE_SERVICE.fetch(
    `https://enterprise/orgs/${params.orgId}/saml/connection`,
    {
      method: 'PUT',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) return { error: messageForStatus(res.status) }
  return { saved: true as const }
}

export default function SamlAdmin({ loaderData, actionData }: Route.ComponentProps) {
  const { org, isAdmin, ssoAvailable, entitled, connection, suggestedAcsUrl, suggestedSpEntityId } =
    loaderData
  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : false

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Enterprise SSO (SAML 2.0)</p>
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
              Register your SAML identity provider. Give your IdP the SP values below, then paste
              the IdP’s metadata values (entity id, SSO URL, signing certificate) here.
            </p>
            {saved && <p className="muted">Connection saved. Members can now sign in via SAML.</p>}
            {error && <p className="error-text">{error}</p>}

            <div className="token-box">
              <p className="token-note">ACS (Assertion Consumer Service) URL:</p>
              <code className="token-value">{suggestedAcsUrl}</code>
            </div>

            <Form method="post" className="form" style={{ marginTop: '1.5rem' }}>
              <label>
                IdP Entity ID
                <input name="idpEntityId" defaultValue={connection.idpEntityId ?? ''} required />
              </label>
              <label>
                IdP SSO URL
                <input
                  name="idpSsoUrl"
                  type="url"
                  defaultValue={connection.idpSsoUrl ?? ''}
                  required
                />
              </label>
              <label>
                IdP signing certificate (PEM)
                <textarea
                  name="idpCertificate"
                  rows={6}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  required
                />
              </label>
              <label>
                SP Entity ID
                <input
                  name="spEntityId"
                  defaultValue={connection.spEntityId ?? suggestedSpEntityId}
                  required
                />
              </label>
              <label>
                ACS URL
                <input
                  name="acsUrl"
                  type="url"
                  defaultValue={connection.acsUrl ?? suggestedAcsUrl}
                  required
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
