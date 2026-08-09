import {
  ActionGroup,
  Button,
  Callout,
  CardTable,
  Chip,
  type ChipVariant,
  EmptyRow,
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
import { Form, Link, redirect } from 'react-router'
import { LocalTime } from '../components/local-time'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { getToken, loginRedirect } from '../lib/session.server'
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
  /** Set when an identity provider has deprovisioned them over SCIM. */
  deactivatedAt: string | null
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

type SortKey = 'name' | 'role' | 'joined'
type SortDir = 'asc' | 'desc'

/** Owner → admin → member, so sorting by role ranks by privilege rather than
 * alphabetically (which would put admin above owner and read as wrong). */
const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, member: 2 }

/**
 * Filter and sort the roster in the browser.
 *
 * The api returns the whole roster in one response and there is no server-side
 * search, so doing this client-side keeps it instant and avoids a round trip
 * per keystroke. It stays honest up to the low thousands; past that the roster
 * needs real pagination in the api, not a bigger client-side sort.
 */
function visibleMembers(
  members: Member[],
  q: string,
  roleFilter: string,
  sort: SortKey,
  dir: SortDir,
): Member[] {
  const needle = q.trim().toLowerCase()
  const filtered = members.filter((m) => {
    if (roleFilter && m.role !== roleFilter) return false
    if (!needle) return true
    return m.email.toLowerCase().includes(needle) || (m.name ?? '').toLowerCase().includes(needle)
  })
  const sign = dir === 'desc' ? -1 : 1
  return filtered.sort((a, b) => {
    if (sort === 'role') return sign * (ROLE_RANK[a.role] - ROLE_RANK[b.role])
    if (sort === 'joined') return sign * (Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
    return sign * (a.name ?? a.email).localeCompare(b.name ?? b.email)
  })
}

const ROLE_CHIP: Record<Role, ChipVariant> = {
  owner: 'kind-flag',
  admin: 'kind-config',
  member: 'neutral',
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = await getToken(request, context.get(cloudflareContext).env)
  if (!token) throw loginRedirect(request)
  const env = context.get(cloudflareContext).env
  const headers = { authorization: `Bearer ${token}` }

  const orgsRes = await env.API_SERVICE.fetch('https://api/api/v1/organizations', { headers })
  if (orgsRes.status === 401) throw loginRedirect(request)
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

  const url = new URL(request.url)
  return {
    org,
    members: body.members,
    role: body.role,
    viewerId: body.viewerId,
    invitations,
    security,
    q: url.searchParams.get('q') ?? '',
    roleFilter: url.searchParams.get('role') ?? '',
    sort: (url.searchParams.get('sort') ?? 'name') as SortKey,
    dir: (url.searchParams.get('dir') ?? 'asc') as SortDir,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = await getToken(request, context.get(cloudflareContext).env)
  if (!token) throw loginRedirect(request)
  const env = context.get(cloudflareContext).env
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

  // The `security` intent moved to routes/org.security.tsx — the roster page
  // is no longer where org-wide policy is edited.
  return { error: 'Unknown action' }
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { org, members, role, viewerId, invitations, security, q, roleFilter, sort, dir } =
    loaderData
  const isAdmin = role === 'owner' || role === 'admin'
  const isOwner = role === 'owner'
  // Counted across the whole roster, not the filtered view — the last-owner
  // guard must not relax just because a search hid the other owners.
  const ownerCount = members.filter((m) => m.role === 'owner').length
  const shown = visibleMembers(members, q, roleFilter, sort, dir)
  const narrowed = Boolean(q || roleFilter)

  /** Sorting is a link, so a filtered+sorted roster is a shareable URL. */
  const sortHref = (key: SortKey) => {
    const next = new URLSearchParams()
    if (q) next.set('q', q)
    if (roleFilter) next.set('role', roleFilter)
    next.set('sort', key)
    next.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc')
    return `?${next}`
  }
  const sortState = (key: SortKey) => (sort === key ? dir : 'none')

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
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

      <Form method="get" className="my-5 flex flex-wrap items-end gap-3">
        <Field label="Search">
          <Input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name or email"
            aria-label="Search members by name or email"
          />
        </Field>
        <Field label="Role">
          <Select name="role" defaultValue={roleFilter}>
            <option value="">All roles</option>
            <option value="owner">owner</option>
            <option value="admin">admin</option>
            <option value="member">member</option>
          </Select>
        </Field>
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {narrowed && (
          <Button variant="linklike" size="compact" asChild className="pb-1.5">
            <Link to="?">Clear</Link>
          </Button>
        )}
      </Form>

      <p className="mb-3 text-sm tabular-figures text-muted-foreground">
        {narrowed
          ? `Showing ${shown.length} of ${members.length} members`
          : `${members.length} member${members.length === 1 ? '' : 's'}`}
      </p>

      <CardTable label="Members" stickyHeader>
        <thead>
          <tr>
            <Th sort={sortState('name')}>
              <Link to={sortHref('name')} className="sort-link">
                Member
              </Link>
            </Th>
            <Th sort={sortState('role')}>
              <Link to={sortHref('role')} className="sort-link">
                Role
              </Link>
            </Th>
            <Th sort={sortState('joined')}>
              <Link to={sortHref('joined')} className="sort-link">
                Joined
              </Link>
            </Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => {
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
                  {m.deactivatedAt ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Chip variant={ROLE_CHIP[m.role]}>{m.role}</Chip>
                      <Chip variant="state-off">deactivated</Chip>
                    </span>
                  ) : isAdmin && !lastOwner ? (
                    <RoleControl member={m} canGrantOwner={isOwner} />
                  ) : (
                    <Chip variant={ROLE_CHIP[m.role]}>{m.role}</Chip>
                  )}
                </Td>
                <Td label="Joined" className="text-muted-foreground">
                  <LocalTime epoch={Date.parse(m.joinedAt)} />
                  {m.deactivatedAt && (
                    <span className="block font-mono text-xs text-muted-foreground-subtle">
                      no access since <LocalTime epoch={Date.parse(m.deactivatedAt)} />
                    </span>
                  )}
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
          {shown.length === 0 && (
            <EmptyRow
              colSpan={4}
              title="No members match"
              action={
                <Button variant="secondary" size="compact" asChild>
                  <Link to="?">Clear filters</Link>
                </Button>
              }
            >
              Nobody in this organization matches that search. Someone invited but not yet signed up
              appears under pending invitations, not here.
            </EmptyRow>
          )}
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

      {isAdmin && !security.requireStepUpForReveal && (
        <Callout tone="warn" className="mt-8">
          Secrets in this organization can be revealed without a fresh second factor.{' '}
          <Link to={`/orgs/${org.id}/security`}>Review security policy</Link>.
        </Callout>
      )}

      {!isAdmin && (
        <ActionGroup className="mt-2">
          <span className="text-sm text-muted-foreground">
            You're a member of this organization. Only owners and admins manage the roster.
          </span>
        </ActionGroup>
      )}
    </section>
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
