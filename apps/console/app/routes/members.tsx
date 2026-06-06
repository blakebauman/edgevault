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
import { Form, Link, redirect } from 'react-router'
import { Crumbs } from '../components/crumbs'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/members'

/**
 * Org member management: list the roster, add an existing EdgeVault user by
 * email, change roles, remove. The api enforces RBAC and the last-owner guard;
 * this surfaces it. Email-based invitations (for users without an account yet)
 * wait on transactional email — this is direct membership, the SCIM path's
 * manual equivalent.
 */

type Role = 'owner' | 'admin' | 'member'

interface Member {
  userId: string
  email: string
  name: string | null
  role: Role
  joinedAt: string
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

  return { org, members: body.members, role: body.role, viewerId: body.viewerId }
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
    const res = await env.API_SERVICE.fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: String(form.get('email') ?? '').trim(),
        role: String(form.get('role') ?? 'member'),
      }),
    })
    if (res.ok) return { added: true as const }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'adding the member') }
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

  return { error: 'Unknown action' }
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { org, members, role, viewerId } = loaderData
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
        {actionData && 'roleChanged' in actionData && <StatusNote>Role updated.</StatusNote>}
        {actionData && 'removed' in actionData && <StatusNote>Member removed.</StatusNote>}

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
                    <span className="text-foreground">{m.name ?? m.email}</span>
                    {m.name && (
                      <span className="font-mono text-xs text-muted-foreground"> {m.email}</span>
                    )}
                    {isSelf && <span className="text-xs text-muted-foreground"> · you</span>}
                  </Td>
                  <Td label="Role">
                    {isAdmin && !lastOwner ? (
                      <Form method="post" className="inline">
                        <input type="hidden" name="intent" value="role" />
                        <input type="hidden" name="userId" value={m.userId} />
                        <Select
                          name="role"
                          defaultValue={m.role}
                          className="px-2 py-1 text-xs"
                          aria-label={`Role for ${m.email}`}
                          onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        >
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                          {/* only an owner may grant owner */}
                          {isOwner && <option value="owner">owner</option>}
                        </Select>
                      </Form>
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

        {isAdmin && (
          <>
            <h2>Add a member</h2>
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              Add an existing EdgeVault account by email. They join immediately — no invitation to
              accept. (Email invitations for people without an account yet are coming.)
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
