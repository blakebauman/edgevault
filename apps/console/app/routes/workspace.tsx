import { Select } from '@edgevault/ui'
import { NavLink, Outlet, redirect, useLocation, useNavigate, useParams } from 'react-router'
import { getToken } from '../lib/session.server'
import { getWorkspaceMeta } from '../lib/workspace.server'
import type { Route } from './+types/workspace'

/**
 * The workspace shell: a persistent left sidebar (type sections + workspace
 * tools) and a shared environment switcher. Every in-workspace page renders into
 * the <Outlet/>; the env-scoped sections (Config / Flags / Secrets / Content / API
 * keys) hang off the active environment, which the switcher swaps in place.
 */

type EnvSummary = { id: string; name: string; slug: string }

/** Env-scoped sidebar sections, in order. */
const ENV_SECTIONS = [
  { seg: 'config', label: 'Config' },
  { seg: 'flags', label: 'Feature Flags' },
  { seg: 'content', label: 'Content' },
  { seg: 'secrets', label: 'Secrets' },
  { seg: 'keys', label: 'API keys' },
] as const

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

export default function WorkspaceShell({ loaderData }: Route.ComponentProps) {
  const { workspaceId, environments, activeEnvId } = loaderData
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()

  const envBase = activeEnvId ? `/dashboard/${workspaceId}/env/${activeEnvId}` : null
  const switcherValue = params.envId ?? activeEnvId ?? ''

  return (
    <main className="ws-shell">
      <aside className="ws-sidebar">
        <nav className="ws-nav" aria-label="Workspace">
          <NavLink to={`/dashboard/${workspaceId}`} end className="ws-nav-link">
            Overview
          </NavLink>

          <div className="ws-nav-group">
            <p className="ws-nav-label">Environment</p>
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
                  <NavLink key={s.seg} to={`${envBase}/${s.seg}`} className="ws-nav-link">
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
            <p className="ws-nav-label">Workspace</p>
            <NavLink to={`/dashboard/${workspaceId}/environments`} className="ws-nav-link">
              Environments
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/compare`} className="ws-nav-link">
              Compare
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/audit`} className="ws-nav-link">
              Audit
            </NavLink>
            <NavLink to={`/dashboard/${workspaceId}/notifications`} className="ws-nav-link">
              Notifications
            </NavLink>
          </div>
        </nav>
      </aside>

      <div className="ws-main">
        <Outlet />
      </div>
    </main>
  )
}
