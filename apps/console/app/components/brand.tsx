import { Button } from '@edgevault/ui'
import { Form, Link } from 'react-router'

/** The vault mark — square with a folded corner; the keyway slot is the single
 * accent dose (same mark as the marketing site, light-on-dark variant). */
export function VaultMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path d="M4 4 H20 L28 12 V28 H4 Z" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M20 4 V12 H28" fill="none" stroke="currentColor" strokeWidth="3" />
      <rect x="12" y="16" width="8" height="3" fill="var(--accent)" />
    </svg>
  )
}

/** Persistent app header: brand identity + account actions. Rendered from the
 * root layout on every page; account links only when a session exists. */
export function TopBar({ authed }: { authed: boolean }) {
  return (
    <header className="flex h-13 items-center justify-between gap-4 border-b border-border bg-card px-6">
      <Link
        to="/"
        className="flex items-center gap-2 text-foreground no-underline"
        aria-label="EdgeVault — all workspaces"
      >
        <VaultMark />
        <span className="font-display text-base font-semibold tracking-tight">EdgeVault</span>
      </Link>
      {authed && (
        <nav className="flex items-center gap-5" aria-label="Account">
          <Link
            to="/share"
            className="text-sm text-muted-foreground no-underline hover:text-accent"
          >
            Share a secret
          </Link>
          <Link
            to="/account/mfa"
            className="text-sm text-muted-foreground no-underline hover:text-accent"
          >
            Security
          </Link>
          <Form method="post" action="/logout">
            <Button type="submit" variant="linklike" className="text-sm">
              Sign out
            </Button>
          </Form>
        </nav>
      )}
    </header>
  )
}
