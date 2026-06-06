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
import { getToken } from './lib/session.server'
import './app.css'

/** Cookie-presence only (no network) — drives the TopBar's account links. */
export function loader({ request }: Route.LoaderArgs) {
  return { authed: Boolean(getToken(request)) }
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Available in both the happy path and the ErrorBoundary render.
  const data = useRouteLoaderData<typeof loader>('root')
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
        <TopBar authed={data?.authed ?? false} />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Something went wrong'
  let details =
    'An unexpected error occurred. Your data is safe; try again from the workspaces list.'
  let stack: string | undefined

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? 'Page not found' : `Error ${error.status}`
    details =
      error.status === 404
        ? 'No key resolves at this address. The link may be stale, or the workspace may have moved.'
        : error.statusText || details
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message
    stack = error.stack
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
        {stack && (
          <pre className="error">
            <code>{stack}</code>
          </pre>
        )}
      </section>
    </main>
  )
}
