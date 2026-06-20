import { Outlet, useParams, useRouteLoaderData } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { Crumbs } from '../components/crumbs'
import type { loader as workspaceLoader } from './workspace'

/**
 * Environment context layout: a shared header (which environment you're in) above
 * the type sections. The sidebar drives navigation between Config / Flags /
 * Secrets / Content / API keys; each renders its body into the <Outlet/> below.
 */

export default function EnvironmentLayout() {
  const params = useParams()
  const workspace = useRouteLoaderData<typeof workspaceLoader>('routes/workspace')
  const workspaceId = params.workspaceId ?? ''
  const envId = params.envId ?? ''
  const environment = workspace?.environments.find((e) => e.id === envId)
  const envName = environment ? `${environment.name} /${environment.slug}` : envId
  const workspaceName = workspace?.workspaceName ?? workspaceId

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <Crumbs
            items={[
              { label: 'workspaces', to: '/' },
              { label: workspaceName, to: `/dashboard/${workspaceId}` },
              { label: envName },
            ]}
          />
          <p className="eyebrow">Environment</p>
          <h1>
            {workspaceName} <span className="text-muted-foreground">{envName}</span>
          </h1>
          <span className="page-id">
            <CopyButton value={envId} label="Copy environment id" />
          </span>
        </div>
      </header>

      <Outlet />
    </section>
  )
}
