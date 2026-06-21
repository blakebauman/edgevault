import { cn, Select } from '@edgevault/ui'
import type { ReactNode } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useParams,
  useRouteLoaderData,
} from 'react-router'
import { GlobalAssistant } from '../components/global-assistant'
import { UserMenu } from '../components/user-menu'
import { getToken } from '../lib/session.server'
import { getWorkspaceMeta } from '../lib/workspace.server'
import type { loader as rootLoader } from '../root'
import type { Route } from './+types/workspace'

/**
 * The workspace shell: a persistent left rail (workspace switcher, grouped nav,
 * account menu) and a per-view header (breadcrumb + assistant). Inside a
 * workspace the rail owns the chrome, so root.tsx suppresses the global TopBar.
 * Every in-workspace page renders into the <Outlet/>; the env-scoped sections
 * (Config / Flags / Content / Secrets / API keys) hang off the active
 * environment, which the switcher swaps in place.
 */

type EnvSummary = { id: string; name: string; slug: string }

/** A 16px line icon — single stroke vocabulary across the nav. */
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

/** Env-scoped sidebar sections, in order. */
const ENV_SECTIONS: { seg: string; label: string; icon: ReactNode }[] = [
  {
    seg: 'config',
    label: 'Config',
    icon: (
      <>
        <path d="M12 2 3 7v10l9 5 9-5V7z" />
        <path d="M3.3 7 12 12l8.7-5M12 22V12" />
      </>
    ),
  },
  {
    seg: 'flags',
    label: 'Feature Flags',
    icon: (
      <>
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <path d="M4 22v-7" />
      </>
    ),
  },
  {
    seg: 'content',
    label: 'Content',
    icon: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </>
    ),
  },
  {
    seg: 'secrets',
    label: 'Secrets',
    icon: (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
  },
  {
    seg: 'keys',
    label: 'API keys',
    icon: (
      <>
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="m10.7 12.3 8.6-8.6M16 7l2 2M13 10l2 2" />
      </>
    ),
  },
]

/** Breadcrumb labels for the per-view header. */
const SECTION_LABEL: Record<string, string> = {
  config: 'Config',
  flags: 'Feature Flags',
  content: 'Content',
  secrets: 'Secrets',
  keys: 'API keys',
  pages: 'Content',
  environments: 'Environments',
  compare: 'Compare',
  audit: 'Audit',
  notifications: 'Notifications',
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`

  const [meta, envsRes] = await Promise.all([
    getWorkspaceMeta(env, token, params.workspaceId),
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
  ])
  if (envsRes.status === 401 || envsRes.status === 403) throw redirect('/login')

  const environments = envsRes.ok
    ? ((await envsRes.json()) as { environments: EnvSummary[] }).environments
    : []

  return {
    workspaceId: params.workspaceId,
    workspaceName: meta.name,
    role: meta.role,
    environments,
    // The env the sidebar's type-section links target: the one in the URL, else
    // the first environment.
    activeEnvId: params.envId ?? environments[0]?.id ?? null,
  }
}

/** The env-scoped segment currently shown, so switching env keeps the section. */
function currentSection(pathname: string): string {
  const m = pathname.match(/\/env\/[^/]+\/([^/]+)/)
  const seg = m?.[1]
  // The page editor (pages/:key) has no per-env equivalent across a switch — land
  // the user back on the Content list instead.
  if (seg === 'pages') return 'content'
  return seg ?? 'config'
}

const navClass = ({ isActive }: { isActive: boolean }) => cn('ws-nav-link', isActive && 'active')

export default function WorkspaceShell({ loaderData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, role, environments, activeEnvId } = loaderData
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const root = useRouteLoaderData<typeof rootLoader>('root')

  const envBase = activeEnvId ? `/dashboard/${workspaceId}/env/${activeEnvId}` : null
  const switcherValue = params.envId ?? activeEnvId ?? ''
  const activeEnv = environments.find((e) => e.id === (params.envId ?? activeEnvId))

  // Breadcrumb: workspace › [env] › section. Env-scoped routes carry the env
  // name; everything else is workspace-scoped.
  const envMatch = location.pathname.match(/\/env\/[^/]+(?:\/([^/]+))?/)
  const wsSeg = location.pathname.match(/\/dashboard\/[^/]+\/([^/]+)/)?.[1]
  const envScoped = Boolean(envMatch)
  const sectionLabel = envScoped
    ? (SECTION_LABEL[envMatch?.[1] ?? ''] ?? 'Environment')
    : wsSeg
      ? (SECTION_LABEL[wsSeg] ?? wsSeg)
      : 'Overview'

  const initial = (workspaceName?.trim()[0] ?? 'W').toUpperCase()

  return (
    <main className="ws-shell">
      <aside className="ws-sidebar">
        <Link to="/" className="ws-switch" aria-label="All workspaces">
          <span className="ws-mark" aria-hidden="true">
            {initial}
          </span>
          <span className="ws-switch-meta">
            <span className="ws-switch-name">{workspaceName ?? 'Workspace'}</span>
            <span className="ws-switch-sub">
              {role ? `${role} · all workspaces` : 'All workspaces'}
            </span>
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

        <nav className="ws-nav" aria-label="Workspace">
          <div className="ws-nav-group">
            <p className="ws-nav-label">Workspace</p>
            <NavLink to={`/dashboard/${workspaceId}`} end className={navClass}>
              <NavIcon>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </NavIcon>
              Overview
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/environments`} className={navClass}>
              <NavIcon>
                <path d="m21 16-9 5-9-5V8l9-5 9 5z" />
                <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
              </NavIcon>
              Environments
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/compare`} className={navClass}>
              <NavIcon>
                <rect x="3" y="4" width="7" height="16" rx="1" />
                <rect x="14" y="4" width="7" height="16" rx="1" />
              </NavIcon>
              Compare
            </NavLink>
          </div>

          <div className="ws-nav-group">
            <p className="ws-nav-label">{activeEnv ? activeEnv.name : 'Environment'}</p>
            {environments.length > 0 ? (
              <>
                <Select
                  className="ws-envswitch"
                  value={switcherValue}
                  aria-label="Switch environment"
                  onChange={(e) =>
                    navigate(
                      `/dashboard/${workspaceId}/env/${e.target.value}/${currentSection(location.pathname)}`,
                    )
                  }
                >
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name} /{env.slug}
                    </option>
                  ))}
                </Select>
                {ENV_SECTIONS.map((s) => (
                  <NavLink key={s.seg} to={`${envBase}/${s.seg}`} className={navClass}>
                    <NavIcon>{s.icon}</NavIcon>
                    {s.label}
                  </NavLink>
                ))}
              </>
            ) : (
              <p className="ws-nav-empty">
                No environments yet — create one under Environments to add config, flags, secrets,
                and content.
              </p>
            )}
          </div>

          <div className="ws-nav-group">
            <p className="ws-nav-label">Activity</p>
            <NavLink to={`/dashboard/${workspaceId}/audit`} className={navClass}>
              <NavIcon>
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </NavIcon>
              Audit
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/notifications`} className={navClass}>
              <NavIcon>
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </NavIcon>
              Notifications
            </NavLink>
          </div>
        </nav>

        <div className="ws-foot">
          <UserMenu variant="sidebar" email={root?.email} orgs={root?.orgs ?? []} />
        </div>
      </aside>

      <div className="ws-main">
        <header className="ws-header">
          <nav className="ws-crumbs" aria-label="Breadcrumb">
            <Link to={`/dashboard/${workspaceId}`}>{workspaceName ?? 'Workspace'}</Link>
            {envScoped && activeEnv && (
              <>
                <span className="sep">/</span>
                <span>{activeEnv.name}</span>
              </>
            )}
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
