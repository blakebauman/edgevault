import {
  ActionGroup,
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  ErrorNote,
  Field,
  Input,
  Select,
  StatusNote,
  Td,
  Th,
  TwoStepConfirm,
} from '@edgevault/ui'
import { useState } from 'react'
import { Form, redirect } from 'react-router'
import { Crumbs } from '../components/crumbs'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/members'

/**
 * Org member management: list the roster, add a member by email, change roles,
 * remove. Existing accounts join immediately; unknown addresses get an email
 * invitation (a link bound to that address, delivered via apps/notify). The
 * api enforces RBAC and the last-owner guard; this surfaces it.
 */

type Role = 'owner' | 'admin' | 'member'

interface Member {
  userId: string
  email: string
  name: string | null
  role: Role
  joinedAt: string
}

interface Invitation {
  id: string
  email: string
  role: Role
  expiresAt: string
  createdAt: string
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Members · EdgeVault' }]
}

const ROLE_CHIP: Record<Role, ChipVariant> = {
  owner: 'kind-flag',
  admin: 'kind-config',
  member: 'neutral',
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }

  const orgsRes = await env.API_SERVICE.fetch('https://api/api/v1/organizations', { headers })
  if (orgsRes.status === 401) throw redirect('/login')
  const organizations = orgsRes.ok
    ? ((await orgsRes.json()) as { organizations: Array<{ id: string; name: string }> })
        .organizations
    : []
  const org = organizations.find((o) => o.id === params.orgId)
  if (!org) throw redirect('/')

  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/members`,
    { headers },
  )
  if (res.status === 403) throw redirect('/')
  const body = res.ok
    ? ((await res.json()) as { members: Member[]; role: Role; viewerId: string })
    : { members: [], role: 'member' as Role, viewerId: '' }

  // Pending invitations are an admin view; members get an empty list (403).
  let invitations: Invitation[] = []
  let security = { requireStepUpForReveal: false, requireMfa: false, ssoOnly: false }
  if (body.role === 'owner' || body.role === 'admin') {
    const [invRes, secRes] = await Promise.all([
      env.API_SERVICE.fetch(`https://api/api/v1/organizations/${params.orgId}/invitations`, {
        headers,
      }),
      env.API_SERVICE.fetch(`https://api/api/v1/organizations/${params.orgId}/security`, {
        headers,
      }),
    ])
    if (invRes.ok) {
      invitations = ((await invRes.json()) as { invitations: Invitation[] }).invitations
    }
    if (secRes.ok) {
      security = (await secRes.json()) as typeof security
    }
  }

  return {
    org,
    members: body.members,
    role: body.role,
    viewerId: body.viewerId,
    invitations,
    security,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const base = `https://api/api/v1/organizations/${params.orgId}/members`
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'add') {
    const email = String(form.get('email') ?? '').trim()
    const res = await env.API_SERVICE.fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, role: String(form.get('role') ?? 'member') }),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { invited?: boolean } | null
      return body?.invited ? { invited: email } : { added: true as const }
    }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'adding the member') }
  }

  if (intent === 'resend-invite') {
    const id = String(form.get('invitationId'))
    const res = await env.API_SERVICE.fetch(
      `https://api/api/v1/organizations/${params.orgId}/invitations/${id}/resend`,
      { method: 'POST', headers },
    )
    if (res.ok) return { resent: true as const }
    return { error: friendlyError(res.status, 'resending the invitation') }
  }

  if (intent === 'revoke-invite') {
    const id = String(form.get('invitationId'))
    const res = await env.API_SERVICE.fetch(
      `https://api/api/v1/organizations/${params.orgId}/invitations/${id}`,
      { method: 'DELETE', headers },
    )
    if (res.ok) return { revoked: true as const }
    return { error: friendlyError(res.status, 'revoking the invitation') }
  }

  if (intent === 'role') {
    const userId = String(form.get('userId'))
    const res = await env.API_SERVICE.fetch(`${base}/${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: String(form.get('role')) }),
    })
    if (res.ok) return { roleChanged: true as const }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'changing the role') }
  }

  if (intent === 'remove') {
    const userId = String(form.get('userId'))
    const res = await env.API_SERVICE.fetch(`${base}/${userId}`, { method: 'DELETE', headers })
    if (res.ok) return { removed: true as const }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'removing the member') }
  }

  if (intent === 'security') {
    const res = await env.API_SERVICE.fetch(
      `https://api/api/v1/organizations/${params.orgId}/security`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          requireStepUpForReveal: form.get('requireStepUpForReveal') === 'on',
          requireMfa: form.get('requireMfa') === 'on',
          ssoOnly: form.get('ssoOnly') === 'on',
        }),
      },
    )
    if (res.ok) return { securitySaved: true as const }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'updating the security policy') }
  }

  return { error: 'Unknown action' }
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { org, members, role, viewerId, invitations, security } = loaderData
  const isAdmin = role === 'owner' || role === 'admin'
  const isOwner = role === 'owner'
  const ownerCount = members.filter((m) => m.role === 'owner').length

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <Crumbs
              items={[{ label: 'workspaces', to: '/' }, { label: org.name }, { label: 'members' }]}
            />
            <p className="eyebrow">Members</p>
            <h1>{org.name}</h1>
          </div>
        </header>

        {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
        {actionData && 'added' in actionData && <StatusNote>Member added.</StatusNote>}
        {actionData && 'invited' in actionData && (
          <StatusNote>
            Invitation sent to {actionData.invited} — they'll get an email link, good for 7 days.
          </StatusNote>
        )}
        {actionData && 'resent' in actionData && (
          <StatusNote>Invitation re-sent with a fresh 7-day expiry.</StatusNote>
        )}
        {actionData && 'revoked' in actionData && <StatusNote>Invitation revoked.</StatusNote>}
        {actionData && 'roleChanged' in actionData && <StatusNote>Role updated.</StatusNote>}
        {actionData && 'removed' in actionData && <StatusNote>Member removed.</StatusNote>}
        {actionData && 'securitySaved' in actionData && (
          <StatusNote>Security policy updated.</StatusNote>
        )}

        <CardTable label="Members">
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.userId === viewerId
              // The last owner can't be demoted or removed — match the api guard
              // so the UI never offers an action that will 409.
              const lastOwner = m.role === 'owner' && ownerCount <= 1
              return (
                <tr key={m.userId}>
                  <Td>
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="grid size-7 flex-none place-items-center rounded-sm border border-border bg-vault text-xs font-semibold text-plaintext"
                      >
                        {(m.name ?? m.email).trim()[0]?.toUpperCase() ?? '?'}
                      </span>
                      <span className="min-w-0 leading-tight">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {m.name ?? m.email}
                          {isSelf && <span className="text-muted-foreground"> · you</span>}
                        </span>
                        {m.name && (
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {m.email}
                          </span>
                        )}
                      </span>
                    </span>
                  </Td>
                  <Td label="Role">
                    {isAdmin && !lastOwner ? (
                      <RoleControl member={m} canGrantOwner={isOwner} />
                    ) : (
                      <Chip variant={ROLE_CHIP[m.role]}>{m.role}</Chip>
                    )}
                  </Td>
                  <Td label="Joined" className="text-muted-foreground">
                    <LocalTime epoch={Date.parse(m.joinedAt)} />
                  </Td>
                  <Td>
                    {isAdmin && !lastOwner && !isSelf ? (
                      <TwoStepConfirm trigger="Remove" note={`Remove ${m.email} from ${org.name}?`}>
                        {(close) => (
                          <Form method="post" onSubmit={close}>
                            <input type="hidden" name="intent" value="remove" />
                            <input type="hidden" name="userId" value={m.userId} />
                            <Button type="submit" variant="danger" size="compact">
                              Confirm remove
                            </Button>
                          </Form>
                        )}
                      </TwoStepConfirm>
                    ) : null}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </CardTable>

        {isAdmin && invitations.length > 0 && (
          <>
            <h2>Pending invitations</h2>
            <CardTable label="Pending invitations">
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Expires</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const expired = Date.parse(inv.expiresAt) < Date.now()
                  return (
                    <tr key={inv.id}>
                      <Td>
                        <span className="font-mono text-xs">{inv.email}</span>
                      </Td>
                      <Td label="Role">
                        <Chip variant={ROLE_CHIP[inv.role]}>{inv.role}</Chip>
                      </Td>
                      <Td label="Expires" className="text-muted-foreground">
                        <LocalTime epoch={Date.parse(inv.expiresAt)} />
                        {expired && <span className="text-xs"> · expired</span>}
                      </Td>
                      <Td>
                        <ActionGroup>
                          <Form method="post" className="inline">
                            <input type="hidden" name="intent" value="resend-invite" />
                            <input type="hidden" name="invitationId" value={inv.id} />
                            <Button type="submit" variant="secondary" size="compact">
                              Resend
                            </Button>
                          </Form>
                          <TwoStepConfirm trigger="Revoke" note={`Revoke ${inv.email}'s invite?`}>
                            {(close) => (
                              <Form method="post" onSubmit={close}>
                                <input type="hidden" name="intent" value="revoke-invite" />
                                <input type="hidden" name="invitationId" value={inv.id} />
                                <Button type="submit" variant="danger" size="compact">
                                  Confirm revoke
                                </Button>
                              </Form>
                            )}
                          </TwoStepConfirm>
                        </ActionGroup>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </CardTable>
          </>
        )}

        {isAdmin && (
          <>
            <h2>Add a member</h2>
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              Existing EdgeVault accounts join immediately. Anyone else gets an email invitation — a
              link bound to their address, good for 7 days.
            </p>
            <Form method="post" className="mt-4 flex max-w-md flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="add" />
              <Field label="Email" className="flex-1">
                <Input type="email" name="email" required placeholder="teammate@example.com" />
              </Field>
              <Field label="Role">
                <Select name="role" defaultValue="member">
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  {isOwner && <option value="owner">owner</option>}
                </Select>
              </Field>
              <Button type="submit">Add</Button>
            </Form>
          </>
        )}

        {isAdmin && (
          <>
            <h2>Security</h2>
            {!security.requireStepUpForReveal && (
              <StatusNote>
                Secrets in this organization can currently be revealed without a fresh second
                factor. New organizations require step-up by default — consider turning it on.
              </StatusNote>
            )}
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              Step-up asks for a fresh second factor (passkey or authenticator code) before any
              secret is revealed — being signed in isn't enough. Machine API keys (CLI / CI) are
              unaffected. Require-MFA and SSO-only gate every member's access to this organization
              at sign-in.
            </p>
            <Form method="post" className="mt-4 flex flex-col gap-2">
              <input type="hidden" name="intent" value="security" />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="requireStepUpForReveal"
                  defaultChecked={security.requireStepUpForReveal}
                />
                Require step-up to reveal secrets
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requireMfa" defaultChecked={security.requireMfa} />
                Require two-factor auth (TOTP or passkey) for all members
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="ssoOnly" defaultChecked={security.ssoOnly} />
                SSO-only — members must sign in through this org's identity provider
              </label>
              <Button type="submit" variant="secondary" size="compact" className="self-start">
                Save
              </Button>
            </Form>
          </>
        )}

        {!isAdmin && (
          <ActionGroup className="mt-2">
            <span className="text-sm text-muted-foreground">
              You're a member of this organization. Only owners and admins manage the roster.
            </span>
          </ActionGroup>
        )}
      </section>
    </main>
  )
}

/**
 * Role change as a deliberate act, not a side effect of opening a dropdown.
 * Picking a new role stages it; an explicit Save commits. Owner transitions
 * (granting owner, or moving someone off owner) wear the danger voice — they
 * cross a privilege boundary. Browsing the options never submits anything,
 * which also keeps screen-reader option-arrowing from firing a PATCH.
 */
function RoleControl({ member, canGrantOwner }: { member: Member; canGrantOwner: boolean }) {
  const [pending, setPending] = useState<Role>(member.role)
  const changed = pending !== member.role
  const ownerBoundary = pending === 'owner' || member.role === 'owner'

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Select
        value={pending}
        onChange={(e) => setPending(e.currentTarget.value as Role)}
        className="px-2 py-1 text-xs"
        aria-label={`Role for ${member.email}`}
      >
        <option value="member">member</option>
        <option value="admin">admin</option>
        {/* only an owner may grant owner */}
        {canGrantOwner && <option value="owner">owner</option>}
      </Select>
      {changed && (
        <Form method="post" className="inline-flex items-center gap-2">
          <input type="hidden" name="intent" value="role" />
          <input type="hidden" name="userId" value={member.userId} />
          <input type="hidden" name="role" value={pending} />
          <Button type="submit" variant={ownerBoundary ? 'danger' : 'secondary'} size="compact">
            {ownerBoundary ? `Confirm → ${pending}` : `Save ${pending}`}
          </Button>
          <Button
            type="button"
            variant="linklike"
            size="compact"
            onClick={() => setPending(member.role)}
          >
            Cancel
          </Button>
        </Form>
      )}
    </span>
  )
}
