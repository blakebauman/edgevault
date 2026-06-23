import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { VaultMark } from './brand'

/**
 * The shared frame for the pre-auth screens (sign in, password reset, MFA,
 * email verification): a single centered card carrying the EdgeVault mark, the
 * page title, and the form. root.tsx suppresses the global TopBar on these
 * routes, so the card is the whole surface — a focused, distraction-free
 * moment rather than a form floating in the app chrome.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Link to="/" className="auth-brand" aria-label="EdgeVault">
          <VaultMark />
          <span>EdgeVault</span>
        </Link>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </section>
    </main>
  )
}
