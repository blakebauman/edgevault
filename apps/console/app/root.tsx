import { Button } from '@edgevault/ui'
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from 'react-router'
import type { Route } from './+types/root'
import { TopBar } from './components/brand'
import type { OrgSummary } from './components/user-menu'
import { useNonce } from './lib/nonce'
import { getToken } from './lib/session.server'
import './app.css'

/** Drives the TopBar's account menu: cookie-presence for the authed state, plus
 * the caller's orgs (id/name/role) so the dropdown can list org settings on
 * every page. Best-effort — a slow or down api leaves the menu org-less rather
 * than blanking the whole shell. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) return { authed: false as const, orgs: [] as OrgSummary[], email: undefined }
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }
  let orgs: OrgSummary[] = []
  let email: string | undefined
  try {
    const [orgsRes, meRes] = await Promise.all([
      env.API_SERVICE.fetch('https://api/api/v1/organizations', { headers }),
      env.AUTH_SERVICE.fetch('https://auth/me', { headers }),
    ])
    if (orgsRes.ok) orgs = ((await orgsRes.json()) as { organizations: OrgSummary[] }).organizations
    if (meRes.ok) email = ((await meRes.json()) as { user?: { email?: string } }).user?.email
  } catch {
    // best-effort — the shell renders without the org list / email
  }
  return { authed: true as const, orgs, email }
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Available in both the happy path and the ErrorBoundary render.
  const data = useRouteLoaderData<typeof loader>('root')
  const nonce = useNonce()
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Martian+Mono:wght@400&display=swap"
          rel="stylesheet"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <TopBar authed={data?.authed ?? false} orgs={data?.orgs ?? []} email={data?.email} />
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

// Dev-only: Vite statically strips this branch from production builds, so a
// stack trace can never render in prod even if the surrounding logic changes.
function DevStack({ error }: { error: unknown }) {
  if (!import.meta.env.DEV) return null
  if (!(error instanceof Error) || !error.stack) return null
  return (
    <pre className="error">
      <code>{error.stack}</code>
    </pre>
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Something went wrong'
  let details =
    'An unexpected error occurred. Your data is safe; try again from the workspaces list.'

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? 'Page not found' : `Error ${error.status}`
    details =
      error.status === 404
        ? 'No key resolves at this address. The link may be stale, or the workspace may have moved.'
        : // 5xx statusText can carry internals; keep the generic copy for those.
          (error.status < 500 && error.statusText) || details
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message
  }

  return (
    <main className="shell shell-center">
      <title>{`${message} · EdgeVault`}</title>
      <section className="hero" role="alert">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>{message}</h1>
        <p className="lede">{details}</p>
        <Button asChild className="mt-4 self-start">
          <Link to="/">← Back to workspaces</Link>
        </Button>
        <DevStack error={error} />
      </section>
    </main>
  )
}
