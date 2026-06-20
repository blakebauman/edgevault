import { Button, CardTable, Chip, ErrorNote, Field, Input, StatusNote, Td, Th } from '@edgevault/ui'
import { useState } from 'react'
import { Form, Link } from 'react-router'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/home'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'EdgeVault Console' }]
}

interface Org {
  id: string
  name: string
  slug: string
  role: string
  workspaces: Array<{ id: string; name: string; slug: string; environments: number }>
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) {
    return { authed: false as const, orgs: [] as Org[], joined: null, emailVerified: true }
  }
  // ?joined=<orgId> set by the invitation accept flow — resolved to a name below.
  const joinedId = new URL(request.url).searchParams.get('joined')

  const env = context.cloudflare.env
  const [res, meRes] = await Promise.all([
    env.API_SERVICE.fetch('https://api/api/v1/organizations', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env.AUTH_SERVICE.fetch('https://auth/me', {
      headers: { authorization: `Bearer ${token}` },
    }),
  ])
  // Soft gate: unverified accounts can browse, but org create/join is blocked
  // api-side — the banner explains why before they hit the 403.
  const emailVerified = meRes.ok
    ? (((await meRes.json()) as { user?: { emailVerified?: boolean } }).user?.emailVerified ?? true)
    : true
  if (!res.ok) {
    return { authed: false as const, orgs: [] as Org[], joined: null, emailVerified: true }
  }

  const { organizations } = (await res.json()) as {
    organizations: Array<{ id: string; name: string; slug: string; role: string }>
  }
  const headers = { authorization: `Bearer ${token}` }
  // One workspaces request per org — env counts now come folded into that
  // response (the api hops the DOs server-side), so no per-workspace round-trip.
  const orgs = await Promise.all(
    organizations.map(async (org): Promise<Org> => {
      const wsRes = await env.API_SERVICE.fetch(
        `https://api/api/v1/organizations/${org.id}/workspaces`,
        { headers },
      )
      const workspaces = wsRes.ok
        ? ((await wsRes.json()) as { workspaces: Org['workspaces'] }).workspaces
        : []
      return { ...org, workspaces }
    }),
  )
  const joined = joinedId ? (orgs.find((o) => o.id === joinedId)?.name ?? null) : null
  return { authed: true as const, orgs, joined, emailVerified }
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) return { error: 'Sign in first.' }
  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'resend-verification') {
    const res = await env.AUTH_SERVICE.fetch('https://auth/verify-email/resend', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    return res.ok
      ? { resent: true }
      : { error: 'Could not send the verification email. Try again in a minute.' }
  }

  const body = JSON.stringify({
    name: String(form.get('name') ?? '').trim(),
    slug: String(form.get('slug') ?? '').trim(),
  })
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  if (intent === 'create-org') {
    const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
      method: 'POST',
      headers,
      body,
    })
    if (res.ok) return { created: true }
    const orgBody = (await res.json().catch(() => null)) as { detail?: string } | null
    return { error: orgBody?.detail ?? friendlyError(res.status, 'creating the organization') }
  }
  if (intent === 'create-workspace') {
    const orgId = String(form.get('orgId'))
    const res = await env.API_SERVICE.fetch(
      `https://api/api/v1/organizations/${orgId}/workspaces`,
      { method: 'POST', headers, body },
    )
    if (res.ok) return { created: true }
    const wsBody = (await res.json().catch(() => null)) as { detail?: string } | null
    return { error: wsBody?.detail ?? friendlyError(res.status, 'creating the workspace') }
  }
  return { error: 'Unknown action' }
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.authed) {
    return (
      <main className="shell shell-center">
        <section className="hero">
          <p className="eyebrow">EdgeVault Console</p>
          <h1>Configuration, secrets &amp; flags at the edge.</h1>
          <p className="lede">Sign in to manage your workspaces with live updates.</p>
          <Button asChild>
            <Link to="/login">Sign in →</Link>
          </Button>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <h1>Your workspaces</h1>
          {loaderData.orgs.length > 0 && <NewOrgAction />}
        </header>
        {loaderData.joined && <StatusNote>You're in — welcome to {loaderData.joined}.</StatusNote>}
        {!loaderData.emailVerified && (
          <Form
            method="post"
            className="flex flex-wrap items-baseline gap-3 rounded-sm border border-border bg-card p-3 text-sm"
          >
            <input type="hidden" name="intent" value="resend-verification" />
            <span className="text-muted-foreground">
              Verify your email to create organizations and accept invitations — check your inbox.
            </span>
            <Button type="submit" variant="secondary" size="compact">
              {actionData && 'resent' in actionData && actionData.resent
                ? 'Sent — check again'
                : 'Resend email'}
            </Button>
          </Form>
        )}
        {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
        {loaderData.orgs.length === 0 && (
          <div className="max-w-xl">
            <p className="lede">Three steps from here to a config served at the edge.</p>
            <ol className="m-0 mt-4 flex list-none flex-col gap-2 p-0 font-mono text-sm text-muted-foreground">
              <li>
                <span className="text-accent">1 · organization</span> — members and billing live
                here.
              </li>
              <li>
                <span className="text-accent">2 · workspace</span> — its own vault, environments,
                and audit trail.
              </li>
              <li>
                <span className="text-accent">3 · first config</span> — saved once, readable
                worldwide in under 10 ms.
              </li>
            </ol>
            <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
              <input type="hidden" name="intent" value="create-org" />
              <Field label="Organization name">
                <Input type="text" name="name" required placeholder="Acme Inc" />
              </Field>
              <Field label="Slug">
                <Input type="text" name="slug" required placeholder="acme" />
              </Field>
              <Button type="submit" className="self-start">
                Create organization
              </Button>
            </Form>
          </div>
        )}
        {loaderData.orgs.map((org, i) => (
          <OrgSection key={org.id} org={org} first={i === 0} />
        ))}
      </section>
    </main>
  )
}

/** "New organization" lives on the page header — it's a page-level act, not an
 * org-level one. The form unfolds in a bordered drawer below the header. */
function NewOrgAction() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? 'Close' : 'New organization'}
      </Button>
      {open && (
        <Form
          method="post"
          className="flex w-full max-w-sm flex-col gap-3 rounded-sm border border-border bg-card p-4"
        >
          <input type="hidden" name="intent" value="create-org" />
          <Field label="Name">
            <Input type="text" name="name" required placeholder="Acme Inc" autoFocus />
          </Field>
          <Field label="Slug">
            <Input type="text" name="slug" required placeholder="acme" />
          </Field>
          <Button type="submit" className="self-start">
            Create organization
          </Button>
        </Form>
      )}
    </>
  )
}

function OrgSection({ org, first }: { org: Org; first: boolean }) {
  const [creating, setCreating] = useState(org.workspaces.length === 0)

  const ghostCard = (
    <button
      type="button"
      onClick={() => setCreating((v) => !v)}
      aria-expanded={creating}
      className="grid min-h-[7rem] cursor-pointer place-items-center rounded-sm border border-dashed border-input bg-transparent p-4 text-sm text-muted-foreground transition-colors hover:border-accent hover:text-accent"
    >
      + New workspace
    </button>
  )

  return (
    <section className={first ? 'mt-2' : 'mt-10 border-t border-border pt-8'}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="flex items-baseline gap-3">
          <h2 className="m-0 text-lg">{org.name}</h2>
          <Chip variant="neutral">{org.role}</Chip>
        </span>
      </div>

      {org.workspaces.length === 0 && (
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">
          No workspaces yet — step 2: create one. Environments, configs, and the audit trail all
          live inside it.
        </p>
      )}

      {org.workspaces.length <= 10 ? (
        /* a handful of workspaces browse better as cards; the table takes
           over past ten, where scanning beats browsing */
        <div className="mt-4 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
          {org.workspaces.map((ws) => (
            <Link
              key={ws.id}
              to={`/dashboard/${ws.id}`}
              className="group rounded-sm border border-border bg-card p-4 no-underline transition-colors hover:border-accent"
            >
              <div className="font-display text-base font-semibold text-foreground">{ws.name}</div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">/{ws.slug}</div>
              <div className="mt-4 flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">
                  {ws.environments} environment{ws.environments === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-muted-foreground transition-colors group-hover:text-accent">
                  Open →
                </span>
              </div>
            </Link>
          ))}
          {ghostCard}
        </div>
      ) : (
        <div className="mt-3">
          <CardTable label={`${org.name} workspaces`}>
            <thead>
              <tr>
                <Th>Workspace</Th>
                <Th>Environments</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {org.workspaces.map((ws) => (
                <tr key={ws.id}>
                  <Td>
                    <Link to={`/dashboard/${ws.id}`}>{ws.name}</Link>{' '}
                    <span className="font-mono text-sm text-muted-foreground">/{ws.slug}</span>
                  </Td>
                  <Td label="Environments" className="text-muted-foreground">
                    {ws.environments}
                  </Td>
                  <Td>
                    <Button variant="secondary" size="compact" asChild>
                      <Link to={`/dashboard/${ws.id}`}>Open →</Link>
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </CardTable>
          <div className="mt-3">{ghostCard}</div>
        </div>
      )}

      {creating && (
        <Form
          method="post"
          className="mt-4 flex max-w-sm flex-col gap-3 rounded-sm border border-border bg-card p-4"
        >
          <input type="hidden" name="intent" value="create-workspace" />
          <input type="hidden" name="orgId" value={org.id} />
          <Field label="Name">
            <Input type="text" name="name" required placeholder="Storefront" />
          </Field>
          <Field label="Slug">
            <Input type="text" name="slug" required placeholder="storefront" />
          </Field>
          <Button type="submit" className="self-start">
            Create workspace
          </Button>
        </Form>
      )}
    </section>
  )
}
