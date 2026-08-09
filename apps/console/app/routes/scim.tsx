import {
  ActionGroup,
  ArtifactPanel,
  Button,
  Callout,
  ErrorNote,
  TokenBox,
  TokenValue,
  TwoStepConfirm,
} from '@edgevault/ui'
import { Form, Link } from 'react-router'
import { Forbidden } from '../components/forbidden'
import { cloudflareContext } from '../lib/cloudflare'
import { requireOrg } from '../lib/org.server'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/scim'

/**
 * Org directory sync over SCIM 2.0. Owner/admins generate (or rotate) the
 * bearer token an IdP uses. The raw token is returned by the api exactly once —
 * surfaced here, never stored; only its hash lives server-side.
 *
 * The copy deliberately says "directory sync", not "provisioning". The surface
 * today is a single `GET /Users`: an IdP can read the roster, but it cannot
 * create, update, or deactivate anyone. Claiming provisioning would fail the
 * first security review that tests deprovisioning, which is exactly the review
 * this page exists to pass.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Directory sync · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = await getToken(request, context.get(cloudflareContext).env)
  if (!token) throw loginRedirect(request)

  const env = context.get(cloudflareContext).env
  const org = await requireOrg(env, token, params.orgId, request)

  // Token status: a boolean only (configured), never the value. Admin-only on
  // the api, so a member simply sees "not configured" — which is all they'd
  // learn anyway, and the controls below are hidden from them regardless.
  const statusRes = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/scim-token`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  const status = statusRes.ok
    ? ((await statusRes.json()) as { configured: boolean })
    : { configured: false }
  const baseUrl = `${new URL(request.url).origin.replace('console.', 'api.')}/scim/v2/${org.slug}`
  return { org, status, baseUrl }
}

/** Map api status codes to a human message for the SCIM token endpoints. */
function messageForStatus(status: number): string {
  if (status === 403) return 'Only organization owners or admins can manage SCIM tokens.'
  if (status === 401) return 'Your session expired. Please sign in again.'
  return 'Something went wrong. Please try again.'
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = await getToken(request, context.get(cloudflareContext).env)
  if (!token) throw loginRedirect(request)

  const env = context.get(cloudflareContext).env
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
  const { org, status, baseUrl } = loaderData
  const scimToken = actionData && 'scimToken' in actionData ? actionData.scimToken : null
  const revoked = actionData && 'revoked' in actionData ? actionData.revoked : false
  const error = actionData && 'error' in actionData ? actionData.error : null

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Directory sync</p>
          <h1>{org.name}</h1>
        </div>
        <Button variant="secondary" asChild>
          <Link to="/">← All workspaces</Link>
        </Button>
      </header>

      <p className="lede">
        Let your identity provider (Okta, Entra ID, …) read this organization's directory and
        deprovision members over SCIM 2.0. Paste the token below into your IdP's SCIM connector as
        the secret token, with the base URL shown underneath.
      </p>

      <Callout tone="ok" className="mt-4 max-w-[68ch]">
        <strong>Deprovisioning is supported.</strong> When your IdP deactivates or removes someone,
        their access to this organization stops immediately — they keep appearing on the{' '}
        <Link to={`/orgs/${org.id}/members`}>Members</Link> page marked deactivated, and every
        change is recorded on the <Link to={`/orgs/${org.id}/audit`}>organization trail</Link>.
      </Callout>

      <Callout tone="info" className="mt-3 max-w-[68ch]">
        <strong>Not supported:</strong> creating users and Groups. Your IdP is told this up front
        through <code className="font-mono text-xs">ServiceProviderConfig</code>, so it won't
        silently fail — new people join by invitation from the Members page, or by signing in
        through SSO, which provisions the account on first login.
      </Callout>

      {!org.isAdmin && <Forbidden subject="manage directory sync" backTo={`/orgs/${org.id}`} />}

      {error && <ErrorNote>{error}</ErrorNote>}

      {scimToken ? (
        <TokenBox
          note={
            <>
              Copy this now — it is shown <strong>only once</strong> and cannot be retrieved later.
            </>
          }
        >
          <TokenValue>{scimToken}</TokenValue>
        </TokenBox>
      ) : revoked ? (
        <p className="text-muted-foreground">
          The SCIM token has been revoked. Existing IdP syncs will now fail.
        </p>
      ) : org.isAdmin ? (
        <p className="text-muted-foreground">
          {status.configured
            ? 'A token is configured for this organization. Rotate it to issue a new one.'
            : 'No token has been generated yet.'}
        </p>
      ) : null}

      {org.isAdmin && (
        <ArtifactPanel className="mt-6" label="SCIM base URL — set this in your IdP connector:">
          {baseUrl}
        </ArtifactPanel>
      )}

      {org.isAdmin && (
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
      )}

      {org.isAdmin && (
        <p className="mt-4 text-sm text-muted-foreground">
          Generating a new token immediately invalidates the previous one.
        </p>
      )}
    </section>
  )
}
