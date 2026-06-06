import { Button, ErrorNote, Field, Input, Textarea, TokenBox, TokenValue } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { Forbidden } from '../components/forbidden'
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
  if (isAdmin && env.ENTERPRISE_SERVICE) {
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

export default function SamlAdmin({ loaderData, actionData, params }: Route.ComponentProps) {
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
          <Button variant="secondary" asChild>
            <Link to="/">← All workspaces</Link>
          </Button>
        </header>

        {!isAdmin && <Forbidden subject="configure SSO" />}
        {isAdmin && !ssoAvailable && (
          <ErrorNote>Enterprise SSO is not enabled for this deployment.</ErrorNote>
        )}
        {isAdmin && ssoAvailable && !entitled && (
          <ErrorNote>
            This organization’s plan does not include enterprise SSO.{' '}
            <Link to={`/orgs/${params.orgId}/billing`}>Upgrade on the billing page</Link> to enable
            it.
          </ErrorNote>
        )}

        {isAdmin && ssoAvailable && entitled && (
          <>
            <p className="lede">
              Register your SAML identity provider. Give your IdP the SP values below, then paste
              the IdP’s metadata values (entity id, SSO URL, signing certificate) here.
            </p>
            {saved && (
              <p className="text-muted-foreground">
                Connection saved. Members can now sign in via SAML.
              </p>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}

            <TokenBox note="ACS (Assertion Consumer Service) URL:">
              <TokenValue>{suggestedAcsUrl}</TokenValue>
            </TokenBox>

            <Form method="post" className="mt-6 flex max-w-md flex-col gap-3 stack-gap">
              <Field label="IdP Entity ID">
                <Input name="idpEntityId" defaultValue={connection.idpEntityId ?? ''} required />
              </Field>
              <Field label="IdP SSO URL">
                <Input
                  name="idpSsoUrl"
                  type="url"
                  defaultValue={connection.idpSsoUrl ?? ''}
                  required
                />
              </Field>
              <Field label="IdP signing certificate (PEM)">
                <Textarea
                  name="idpCertificate"
                  rows={6}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  required
                />
              </Field>
              <Field label="SP Entity ID">
                <Input
                  name="spEntityId"
                  defaultValue={connection.spEntityId ?? suggestedSpEntityId}
                  required
                />
              </Field>
              <Field label="ACS URL">
                <Input
                  name="acsUrl"
                  type="url"
                  defaultValue={connection.acsUrl ?? suggestedAcsUrl}
                  required
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
