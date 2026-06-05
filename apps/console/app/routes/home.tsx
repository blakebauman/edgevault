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

export default function Home({ loaderData }: Route.ComponentProps) {
  if (!loaderData.authed) {
    return (
      <main className="shell">
        <section className="hero">
          <p className="eyebrow">EdgeVault Console</p>
          <h1>Configuration, secrets &amp; flags at the edge.</h1>
          <p className="lede">Sign in to manage your workspaces with live updates.</p>
          <Link className="button" to="/login">
            Sign in →
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <h1>Your workspaces</h1>
          <span className="org-links">
            <Link to="/share" className="muted">
              Share a secret →
            </Link>
            <Link to="/account/mfa" className="muted">
              Two-factor auth →
            </Link>
            <Form method="post" action="/logout">
              <button type="submit" className="secondary">
                Sign out
              </button>
            </Form>
          </span>
        </header>
        {loaderData.orgs.length === 0 && <p className="lede">No organizations yet.</p>}
        {loaderData.orgs.map((org) => (
          <div key={org.id} className="org">
            <div className="panel-head">
              <h2>{org.name}</h2>
              <span className="org-links">
                <Link to={`/orgs/${org.id}/billing`} className="muted">
                  Billing →
                </Link>
                <Link to={`/orgs/${org.id}/sso`} className="muted">
                  OIDC →
                </Link>
                <Link to={`/orgs/${org.id}/saml`} className="muted">
                  SAML →
                </Link>
                <Link to={`/orgs/${org.id}/scim`} className="muted">
                  SCIM →
                </Link>
              </span>
            </div>
            <ul className="ws-list">
              {org.workspaces.map((ws) => (
                <li key={ws.id}>
                  <Link to={`/dashboard/${ws.id}`}>{ws.name}</Link>
                  <span className="muted"> /{ws.slug}</span>
                </li>
              ))}
              {org.workspaces.length === 0 && <li className="muted">No workspaces</li>}
            </ul>
          </div>
        ))}
      </section>
    </main>
  )
}
