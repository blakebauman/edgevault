import { Button } from '@edgevault/ui'
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type ShouldRevalidateFunctionArgs,
  useLocation,
  useRouteLoaderData,
} from 'react-router'
import type { Route } from './+types/root'
import { TopBar } from './components/brand'
import type { OrgSummary } from './components/user-menu'
import { useNonce } from './lib/nonce'
import { getToken } from './lib/session.server'
import { loadWorkspaceSwitcher, type SwitcherOrg } from './lib/workspace.server'
import './app.css'

/** Drives the TopBar's account menu and the rail's workspace switcher: cookie-
 * presence for the authed state, plus the caller's orgs each with their
 * workspaces, so the dropdown can switch workspace and list org settings on
 * every page. Best-effort — a slow or down api leaves the menu org-less rather
 * than blanking the whole shell. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  const env = context.cloudflare.env
  // The agent WebSocket connects browser→api directly (like the realtime /ws),
  // so the client needs the api host (without the wss:// scheme).
  const apiHost = env.API_WS_BASE.replace(/^wss?:\/\//, '')
  if (!token) {
    return {
      authed: false as const,
      orgs: [] as OrgSummary[],
      switcherOrgs: [] as SwitcherOrg[],
      email: undefined,
      userId: undefined,
      apiHost,
    }
  }
  const headers = { authorization: `Bearer ${token}` }
  let switcherOrgs: SwitcherOrg[] = []
  let email: string | undefined
  let userId: string | undefined
  try {
    const [orgsWithWorkspaces, meRes] = await Promise.all([
      loadWorkspaceSwitcher(env, token),
      env.AUTH_SERVICE.fetch('https://auth/me', { headers }),
    ])
    switcherOrgs = orgsWithWorkspaces
    if (meRes.ok) {
      const user = ((await meRes.json()) as { user?: { email?: string; id?: string } }).user
      email = user?.email
      userId = user?.id
    }
  } catch {
    // best-effort — the shell renders without the org list / identity
  }
  // The account menu only needs id/name/role; derive it from the richer list.
  const orgs: OrgSummary[] = switcherOrgs.map(({ id, name, role }) => ({ id, name, role }))
  return { authed: true as const, orgs, switcherOrgs, email, userId, apiHost }
}

/** Root data (auth, identity, the org/workspace list) is route-independent, so
 * it only needs refetching after a mutation — not on every navigation. This
 * keeps the rail switcher and account menu fresh after a create/delete while
 * avoiding an orgs+workspaces fan-out on every page change. */
export function shouldRevalidate({ formMethod }: ShouldRevalidateFunctionArgs) {
  return formMethod != null && formMethod !== 'GET'
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Available in both the happy path and the ErrorBoundary render.
  const data = useRouteLoaderData<typeof loader>('root')
  const nonce = useNonce()
  // Inside a workspace or an org-settings area the rail owns the chrome — brand,
  // switcher, account menu, assistant — so the global TopBar is suppressed there
  // to avoid a second header. Every other route keeps it.
  const pathname = useLocation().pathname
  const inShell = /^\/(dashboard\/[^/]+|orgs\/[^/]+)/.test(pathname)
  // The pre-auth screens render their own self-contained card (AuthLayout), so
  // the global TopBar is suppressed there for a focused, chrome-free surface.
  const isAuth = /^\/(login|forgot-password|reset-password|verify-email)(\/|$)/.test(pathname)
  const bareLayout = inShell || isAuth
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
        {!bareLayout && (
          <TopBar authed={data?.authed ?? false} orgs={data?.orgs ?? []} email={data?.email} />
        )}
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
