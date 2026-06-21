import { cn } from '@edgevault/ui'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, redirect, useLocation, useRouteLoaderData } from 'react-router'
import { VaultMark } from '../components/brand'
import { GlobalAssistant } from '../components/global-assistant'
import { ORG_LINKS } from '../components/org-nav'
import { UserMenu } from '../components/user-menu'
import { getToken } from '../lib/session.server'
import type { loader as rootLoader } from '../root'
import type { Route } from './+types/orgs'

/**
 * Org-settings shell: the same left rail + per-view header as the workspace
 * shell, but scoped to one organization's admin sections (members, billing,
 * domains, SSO/SAML/SCIM). root.tsx suppresses the global TopBar here too, so
 * the rail owns the chrome. Each section renders into the <Outlet/>.
 */

// Shared with WorkspaceShell's nav vocabulary; kept local to avoid a circular
// import while the two shells live in separate route modules.
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const ORG_ICON: Record<string, ReactNode> = {
  members: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  billing: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </>
  ),
  domains: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" />
    </>
  ),
  oidc: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  saml: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  scim: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
}

const SECTION_LABEL: Record<string, string> = {
  members: 'Members',
  billing: 'Billing',
  domains: 'Domains',
  sso: 'OIDC',
  saml: 'SAML',
  scim: 'SCIM',
}

const navClass = ({ isActive }: { isActive: boolean }) => cn('ws-nav-link', isActive && 'active')

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const res = await context.cloudflare.env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw redirect('/login')
  const orgs = res.ok
    ? ((await res.json()) as { organizations: Array<{ id: string; name: string }> }).organizations
    : []
  const org = orgs.find((o) => o.id === params.orgId)
  if (!org) throw redirect('/')
  return { orgId: params.orgId, orgName: org.name }
}

export default function OrgShell({ loaderData }: Route.ComponentProps) {
  const { orgId, orgName } = loaderData
  const root = useRouteLoaderData<typeof rootLoader>('root')
  const initial = (orgName.trim()[0] ?? 'O').toUpperCase()
  // The section label for the breadcrumb, from the last path segment.
  const seg = useLocation().pathname.match(/\/orgs\/[^/]+\/([^/]+)/)?.[1] ?? ''
  const sectionLabel = SECTION_LABEL[seg] ?? 'Settings'

  return (
    <main className="ws-shell">
      <aside className="ws-sidebar">
        <Link to="/" className="ws-brand" aria-label="EdgeVault — all workspaces">
          <VaultMark />
          <span className="ws-brand-name">EdgeVault</span>
        </Link>

        <Link to="/" className="ws-switch" aria-label="All workspaces">
          <span className="ws-mark" aria-hidden="true">
            {initial}
          </span>
          <span className="ws-switch-meta">
            <span className="ws-switch-name">{orgName}</span>
            <span className="ws-switch-sub">organization · all workspaces</span>
          </span>
          <svg
            className="ws-chev"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m8 9 4-4 4 4M16 15l-4 4-4-4" />
          </svg>
        </Link>

        <nav className="ws-nav" aria-label="Organization">
          <div className="ws-nav-group">
            <p className="ws-nav-label">Organization</p>
            {ORG_LINKS.map((l) => (
              <NavLink key={l.slug} to={`/orgs/${orgId}/${l.path}`} className={navClass}>
                <NavIcon>{ORG_ICON[l.slug]}</NavIcon>
                {l.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="ws-foot">
          <UserMenu variant="sidebar" email={root?.email} orgs={root?.orgs ?? []} />
        </div>
      </aside>

      <div className="ws-main">
        <header className="ws-header">
          <nav className="ws-crumbs" aria-label="Breadcrumb">
            <Link to="/">Workspaces</Link>
            <span className="sep">/</span>
            <span>{orgName}</span>
            <span className="sep">/</span>
            <span className="cur">{sectionLabel}</span>
          </nav>
          <span className="ws-header-spacer" />
          <GlobalAssistant />
        </header>
        <div className="ws-content">
          <Outlet />
        </div>
      </div>
    </main>
  )
}
