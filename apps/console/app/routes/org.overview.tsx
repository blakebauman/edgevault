import { Callout, Chip, type ChipVariant } from '@edgevault/ui'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cloudflareContext } from '../lib/cloudflare'
import { jsonOr, type OrgRole, requireOrg } from '../lib/org.server'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/org.overview'

/**
 * The org's security posture, as a ledger.
 *
 * Deliberately not a score or a wall of green checkmarks. A score is a number
 * nobody can check, and this audience (see PRODUCT.md — three personas, all
 * "allergic to marketing") reads one as a claim to discount. Instead every row
 * states a control, its current state, and the mechanism that enforces it, in
 * the box-score grammar DESIGN.md §5 already names a signature component.
 *
 * Rows that read "not yet" are the point, not an embarrassment. An evaluator
 * who finds one honest gap trusts the other twenty rows; one who finds all
 * green checks goes looking for the lie.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Overview · EdgeVault' }]
}

type State = 'enforced' | 'configured' | 'off' | 'partial'

const STATE_CHIP: Record<State, ChipVariant> = {
  enforced: 'state-enforced',
  configured: 'state-configured',
  off: 'state-off',
  partial: 'state-partial',
}

const STATE_LABEL: Record<State, string> = {
  enforced: 'enforced',
  configured: 'configured',
  off: 'not set',
  partial: 'partial',
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const org = await requireOrg(env, token, params.orgId, request)
  const headers = { authorization: `Bearer ${token}` }
  const api = (path: string) => env.API_SERVICE.fetch(`https://api/api/v1${path}`, { headers })
  // The auth worker's connection endpoints are internal-token gated and reached
  // only through this BFF (same as sso-admin.tsx).
  const auth = (path: string) =>
    env.AUTH_SERVICE.fetch(`https://auth${path}`, {
      headers: { 'x-internal-token': env.INTERNAL_TOKEN },
    })

  const [security, membersBody, workspacesBody] = await Promise.all([
    api(`/organizations/${params.orgId}/security`).then((r) =>
      jsonOr(r, { requireStepUpForReveal: false, requireMfa: false, ssoOnly: false }),
    ),
    api(`/organizations/${params.orgId}/members`).then((r) =>
      jsonOr(r, { members: [] as Array<{ role: OrgRole }> }),
    ),
    api(`/organizations/${params.orgId}/workspaces`).then((r) =>
      jsonOr(r, { workspaces: [] as Array<{ id: string; name: string }> }),
    ),
  ])

  // Identity, provisioning and invitations are admin-only reads. A plain member
  // still sees the page — the policy rows above are readable by any member —
  // but these come back as nulls rather than a 403 that blanks the screen.
  const [oidc, saml, scim, invitations] = org.isAdmin
    ? await Promise.all([
        auth(`/orgs/${params.orgId}/sso/connection`).then((r) =>
          jsonOr(r, { configured: false } as { configured: boolean; issuer?: string }),
        ),
        auth(`/orgs/${params.orgId}/saml/connection`).then((r) =>
          jsonOr(r, { configured: false } as { configured: boolean; idpEntityId?: string }),
        ),
        api(`/organizations/${params.orgId}/scim-token`).then((r) =>
          jsonOr(r, { configured: false }),
        ),
        api(`/organizations/${params.orgId}/invitations`).then((r) =>
          jsonOr(r, { invitations: [] as unknown[] }),
        ),
      ])
    : [null, null, null, null]

  const byRole = { owner: 0, admin: 0, member: 0 }
  for (const m of membersBody.members) byRole[m.role] = (byRole[m.role] ?? 0) + 1

  return {
    org,
    security,
    byRole,
    memberCount: membersBody.members.length,
    pendingInvites: invitations?.invitations.length ?? null,
    workspaces: workspacesBody.workspaces,
    oidc,
    saml,
    scimConfigured: scim?.configured ?? null,
    scimBaseUrl: `${new URL(request.url).origin.replace('console.', 'api.')}/scim/v2/${org.slug}`,
  }
}

/**
 * One ledger row: the control, its state, and where it bites. `note` carries
 * the mechanism — the thing a security reviewer actually asks for — so the
 * page answers "how do you enforce that" without a support ticket.
 */
function Row({
  label,
  state,
  value,
  note,
  to,
}: {
  label: string
  state?: State
  value?: ReactNode
  note?: ReactNode
  to?: string
}) {
  return (
    <div className="ledger-row">
      <div className="min-w-0">
        <p className="ledger-label">{to ? <Link to={to}>{label}</Link> : label}</p>
        {note && <p className="ledger-note">{note}</p>}
      </div>
      <div className="ledger-value">
        {value !== undefined && <span className="tabular-figures">{value}</span>}
        {state && <Chip variant={STATE_CHIP[state]}>{STATE_LABEL[state]}</Chip>}
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ov-panel">
      <header className="ov-panel-head">
        <h2>{title}</h2>
      </header>
      <div className="ov-panel-body">{children}</div>
    </section>
  )
}

export default function OrgOverview({ loaderData }: Route.ComponentProps) {
  const {
    org,
    security,
    byRole,
    memberCount,
    pendingInvites,
    workspaces,
    oidc,
    saml,
    scimConfigured,
    scimBaseUrl,
  } = loaderData

  const base = `/orgs/${org.id}`
  const idpConnected = Boolean(oidc?.configured || saml?.configured)

  return (
    <section className="panel is-wide">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Organization</p>
          <h1>{org.name}</h1>
        </div>
      </header>

      <p className="lede">
        What this organization enforces, and where each control is applied. Every row links to the
        setting that changes it.
      </p>

      {!org.isAdmin && (
        <Callout tone="info" className="mt-4">
          You're a member of this organization. Policies are shown read-only; owners and admins
          change them.
        </Callout>
      )}

      <div className="ledger-grid">
        <Panel title="Access">
          <Row
            label="Members"
            to={`${base}/members`}
            value={memberCount}
            note={`${byRole.owner} owner${byRole.owner === 1 ? '' : 's'} · ${byRole.admin} admin${byRole.admin === 1 ? '' : 's'} · ${byRole.member} member${byRole.member === 1 ? '' : 's'}`}
          />
          {pendingInvites !== null && (
            <Row
              label="Pending invitations"
              to={`${base}/members`}
              value={pendingInvites}
              note="Invitation links expire 7 days after they're sent"
            />
          )}
          <Row
            label="Two-factor required"
            to={`${base}/security`}
            state={security.requireMfa ? 'enforced' : 'off'}
            note="Checked on every request that touches this organization, against the token's authentication method"
          />
          <Row
            label="SSO-only sign-in"
            to={`${base}/security`}
            state={security.ssoOnly ? 'enforced' : 'off'}
            note="Sessions not established through this org's IdP are refused"
          />
          <Row
            label="Step-up before secret reveal"
            to={`${base}/security`}
            state={security.requireStepUpForReveal ? 'enforced' : 'off'}
            note="A fresh passkey or authenticator code is required; being signed in isn't enough"
          />
        </Panel>

        <Panel title="Identity">
          {org.isAdmin ? (
            <>
              <Row
                label="Single sign-on (OIDC)"
                to={`${base}/sso`}
                state={oidc?.configured ? 'configured' : 'off'}
                note={
                  oidc?.configured ? (
                    <code>{oidc.issuer}</code>
                  ) : (
                    'Authorization code + PKCE, ID token verified against the IdP JWKS'
                  )
                }
              />
              <Row
                label="SAML 2.0"
                to={`${base}/saml`}
                state={saml?.configured ? 'configured' : 'off'}
                note="Signature verification is implemented but not yet externally audited — OIDC is the supported path"
              />
              <Row
                label="Directory sync (SCIM 2.0)"
                to={`${base}/scim`}
                state={scimConfigured ? 'partial' : 'off'}
                note={
                  scimConfigured
                    ? 'Read-only: your IdP can list users. Provisioning and deprovisioning writes are not supported yet.'
                    : 'Issue a bearer token to let your IdP read the directory'
                }
              />
              {scimConfigured && (
                <Row label="SCIM base URL" note={<code>{scimBaseUrl}</code>} to={`${base}/scim`} />
              )}
            </>
          ) : (
            <p className="ledger-note m-0">
              Identity connections are visible to owners and admins.
            </p>
          )}
        </Panel>

        <Panel title="Evidence">
          <Row
            label="Audit retention"
            value="indefinite"
            note="Every change lands in an append-only NDJSON warehouse in R2"
          />
          <Row
            label="Export"
            state="enforced"
            note="Admin-only, returns a SHA-256 digest so the file can be verified after download — and exporting is itself audited"
          />
          <Row
            label="Organization trail"
            to={`${base}/audit`}
            state="enforced"
            note="Membership, role, policy, and credential changes, plus sign-ins refused by this organization's policy"
          />
          <Row
            label="Coverage gap"
            note="Password changes, MFA enrollment, passkey changes, and session revocations are account-level and not yet attributed to an organization"
          />
          <Row
            label="Separation of duties"
            state="enforced"
            note="A parked promotion cannot be approved by the member who opened it"
          />
          {workspaces.length > 0 && (
            <div className="ledger-links">
              {workspaces.map((ws) => (
                <Link key={ws.id} to={`/dashboard/${ws.id}/audit`}>
                  {ws.name}
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Data">
          <Row
            label="Secret storage"
            state="enforced"
            note="Per-secret AES-GCM-256 key, wrapped by an HKDF-derived per-workspace key; plaintext is never persisted"
          />
          <Row
            label="Secrets in AI indexing"
            state="enforced"
            note="Secrets are excluded from semantic indexing entirely and cannot be embedded"
          />
          <Row
            label="Configuration in AI indexing"
            note="Opt-out per workspace, on the workspace's Settings page"
          />
          {workspaces.length > 0 && (
            <div className="ledger-links">
              {workspaces.map((ws) => (
                <Link key={ws.id} to={`/dashboard/${ws.id}/settings`}>
                  {ws.name}
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {org.isAdmin && !idpConnected && (
        <Callout tone="warn" className="mt-6">
          No identity provider is connected, so SSO-only sign-in can't be turned on.{' '}
          <Link to={`${base}/sso`}>Connect one</Link> to enforce it.
        </Callout>
      )}
    </section>
  )
}
