import { Button, ErrorNote, Field, Input } from '@edgevault/ui'
import { Form, Link } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/home'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'EdgeVault Console' }]
}

interface Org {
  id: string
  name: string
  slug: string
  workspaces: Array<{ id: string; name: string; slug: string }>
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) return { authed: false as const, orgs: [] as Org[] }

  const env = context.cloudflare.env
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { authed: false as const, orgs: [] as Org[] }

  const { organizations } = (await res.json()) as {
    organizations: Array<{ id: string; name: string; slug: string }>
  }
  const orgs = await Promise.all(
    organizations.map(async (org): Promise<Org> => {
      const wsRes = await env.API_SERVICE.fetch(
        `https://api/api/v1/organizations/${org.id}/workspaces`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      const workspaces = wsRes.ok
        ? ((await wsRes.json()) as { workspaces: Org['workspaces'] }).workspaces
        : []
      return { ...org, workspaces }
    }),
  )
  return { authed: true as const, orgs }
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) return { error: 'Sign in first.' }
  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent'))
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
    return res.ok
      ? { created: true }
      : { error: `Could not create the organization (${res.status}).` }
  }
  if (intent === 'create-workspace') {
    const orgId = String(form.get('orgId'))
    const res = await env.API_SERVICE.fetch(
      `https://api/api/v1/organizations/${orgId}/workspaces`,
      { method: 'POST', headers, body },
    )
    return res.ok ? { created: true } : { error: `Could not create the workspace (${res.status}).` }
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
        </header>
        {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
        {loaderData.orgs.length === 0 && (
          <p className="lede">No organizations yet — create one below to get started.</p>
        )}
        {loaderData.orgs.map((org) => (
          <div key={org.id} className="org">
            <div className="panel-head">
              <h2>{org.name}</h2>
              <span className="org-links">
                <Link to={`/orgs/${org.id}/billing`} className="text-muted-foreground">
                  Billing →
                </Link>
                <Link to={`/orgs/${org.id}/sso`} className="text-muted-foreground">
                  OIDC →
                </Link>
                <Link to={`/orgs/${org.id}/saml`} className="text-muted-foreground">
                  SAML →
                </Link>
                <Link to={`/orgs/${org.id}/scim`} className="text-muted-foreground">
                  SCIM →
                </Link>
              </span>
            </div>
            <ul className="ws-list">
              {org.workspaces.map((ws) => (
                <li key={ws.id}>
                  <Link to={`/dashboard/${ws.id}`}>{ws.name}</Link>
                  <span className="text-muted-foreground"> /{ws.slug}</span>
                </li>
              ))}
              {org.workspaces.length === 0 && (
                <li className="text-muted-foreground">No workspaces</li>
              )}
            </ul>
            <details className="create-inline">
              <summary>New workspace</summary>
              <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
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
            </details>
          </div>
        ))}
        <details className="create-inline">
          <summary>New organization</summary>
          <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
            <input type="hidden" name="intent" value="create-org" />
            <Field label="Name">
              <Input type="text" name="name" required placeholder="Acme Inc" />
            </Field>
            <Field label="Slug">
              <Input type="text" name="slug" required placeholder="acme" />
            </Field>
            <Button type="submit" className="self-start">
              Create organization
            </Button>
          </Form>
        </details>
      </section>
    </main>
  )
}
