import { Button, Callout, Checkbox, ErrorNote, StatusNote } from '@edgevault/ui'
import type { ReactNode } from 'react'
import { Form, Link } from 'react-router'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { jsonOr, requireOrg } from '../lib/org.server'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/org.security'

/**
 * Org-wide security policy.
 *
 * This lived at the bottom of the Members page, below the add-a-member form —
 * a roster page is not where anyone looks for org policy, and its position
 * read as an afterthought. Each control now states its enforcement point,
 * because "where is that actually checked" is the first question a security
 * reviewer asks and the answer is genuinely good here: all three are enforced
 * server-side at the point a credential is issued or used, not in this UI.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Security · EdgeVault' }]
}

interface Policy {
  requireStepUpForReveal: boolean
  requireMfa: boolean
  ssoOnly: boolean
}

const DEFAULT_POLICY: Policy = {
  requireStepUpForReveal: false,
  requireMfa: false,
  ssoOnly: false,
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const org = await requireOrg(env, token, params.orgId, request)
  const headers = { authorization: `Bearer ${token}` }

  // Any member may read the policy — seeing which controls exist is part of
  // trusting the platform, so a member gets the page read-only rather than a
  // 403. Only the IdP check below is admin-scoped.
  const security = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/security`,
    { headers },
  ).then((r) => jsonOr(r, DEFAULT_POLICY))

  let idpConnected = false
  if (org.isAdmin) {
    const internal = { 'x-internal-token': env.INTERNAL_TOKEN }
    const [oidc, saml] = await Promise.all([
      env.AUTH_SERVICE.fetch(`https://auth/orgs/${params.orgId}/sso/connection`, {
        headers: internal,
      }).then((r) => jsonOr(r, { configured: false })),
      env.AUTH_SERVICE.fetch(`https://auth/orgs/${params.orgId}/saml/connection`, {
        headers: internal,
      }).then((r) => jsonOr(r, { configured: false })),
    ])
    idpConnected = Boolean(oidc.configured || saml.configured)
  }

  return { org, security, idpConnected }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const form = await request.formData()
  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/security`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requireStepUpForReveal: form.get('requireStepUpForReveal') === 'on',
        requireMfa: form.get('requireMfa') === 'on',
        ssoOnly: form.get('ssoOnly') === 'on',
      }),
    },
  )
  if (res.ok) return { saved: true as const }
  // The api returns 409 sso_not_configured with a usable sentence — prefer it
  // over the generic message so the anti-lockout guard explains itself.
  const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
  return { error: detail ?? friendlyError(res.status, 'updating the security policy') }
}

/** One policy switch, with the mechanism that enforces it stated underneath. */
function Policy({
  name,
  label,
  enforcedAt,
  defaultChecked,
  disabled,
  children,
}: {
  name: string
  label: string
  enforcedAt: string
  defaultChecked: boolean
  disabled: boolean
  children: ReactNode
}) {
  return (
    <div className="policy-row">
      <div className="policy-head">
        <Checkbox
          id={name}
          name={name}
          defaultChecked={defaultChecked}
          disabled={disabled}
          aria-describedby={`${name}-desc`}
        />
        <label htmlFor={name} className="policy-label">
          {label}
        </label>
      </div>
      <p id={`${name}-desc`} className="policy-body">
        {children}
      </p>
      <p className="policy-mech">
        <span className="policy-mech-key">Enforced at</span> {enforcedAt}
      </p>
    </div>
  )
}

export default function OrgSecurity({ loaderData, actionData }: Route.ComponentProps) {
  const { org, security, idpConnected } = loaderData
  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : false
  const readOnly = !org.isAdmin

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Security</p>
          <h1>{org.name}</h1>
        </div>
      </header>

      <p className="lede">
        Organization-wide controls, checked server-side rather than in this UI. Each states where it
        is applied — and, where it currently isn't, says so.
      </p>

      {readOnly && (
        <Callout tone="info" className="mt-4">
          You're a member of this organization, so these are read-only. Owners and admins can change
          them.
        </Callout>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && <StatusNote>Security policy saved.</StatusNote>}
      {!security.requireStepUpForReveal && !readOnly && (
        <Callout tone="warn" className="mt-4">
          Secrets in this organization can be revealed without a fresh second factor. New
          organizations require step-up by default.
        </Callout>
      )}
      {!idpConnected && !readOnly && (
        <Callout tone="info" className="mt-4">
          SSO-only can't be enabled until an identity provider is connected.{' '}
          <Link to={`/orgs/${org.id}/sso`}>Set one up</Link>.
        </Callout>
      )}

      <Form method="post" className="mt-6 flex max-w-2xl flex-col gap-1">
        <Policy
          name="requireStepUpForReveal"
          label="Require step-up to reveal secrets"
          enforcedAt="the reveal endpoint, which returns 401 reauth_required without a fresh token"
          defaultChecked={security.requireStepUpForReveal}
          disabled={readOnly}
        >
          Asks for a fresh passkey or authenticator code before any secret is shown. Being signed in
          isn't enough. Machine API keys used by CLI and CI are unaffected, since automation can't
          step up.
        </Policy>

        <Policy
          name="requireMfa"
          label="Require two-factor auth for all members"
          enforcedAt="every request that touches this organization, checked against the token's authentication method and re-verified against your enrolled factors"
          defaultChecked={security.requireMfa}
          disabled={readOnly}
        >
          Members without a confirmed authenticator app or passkey cannot obtain access to this
          organization, whichever way they signed in.
        </Policy>

        <Policy
          name="ssoOnly"
          label="SSO-only sign-in"
          enforcedAt="every request that touches this organization, which refuses sessions not established through your IdP"
          defaultChecked={security.ssoOnly}
          disabled={readOnly}
        >
          Members must reach this organization through its identity provider. Passwords and social
          sign-in stop granting access. Turning this on is blocked until a provider is connected, so
          it can't lock the organization out.
        </Policy>

        {!readOnly && (
          <Button type="submit" className="mt-4 self-start">
            Save policy
          </Button>
        )}
      </Form>
    </section>
  )
}
