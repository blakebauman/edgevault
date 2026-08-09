import { Button, Callout, Checkbox, ErrorNote, StatusNote } from '@edgevault/ui'
import { Form } from 'react-router'
import { Forbidden } from '../components/forbidden'
import { cloudflareContext } from '../lib/cloudflare'
import { friendlyError } from '../lib/errors'
import { getToken, loginRedirect } from '../lib/session.server'
import { getWorkspaceMeta } from '../lib/workspace.server'
import type { Route } from './+types/workspace.settings'

/**
 * Workspace settings — today, one control: whether configuration content is
 * indexed for semantic search.
 *
 * The switch already existed server-side with no way to reach it, which meant
 * the console couldn't answer "does our configuration data reach a model?" —
 * a question that shows up in every vendor security review. The honest answer
 * is nuanced (secrets never are; config is, unless you turn it off), and a
 * page that states it plainly is worth more than a policy PDF.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Settings · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const [meta, settingsRes] = await Promise.all([
    getWorkspaceMeta(env, token, params.workspaceId),
    env.API_SERVICE.fetch(`https://api/api/v1/workspaces/${params.workspaceId}/settings`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  ])
  if (settingsRes.status === 401) throw loginRedirect(request)

  const settings = settingsRes.ok
    ? ((await settingsRes.json()) as { aiIndexingEnabled: boolean })
    : { aiIndexingEnabled: false }

  return {
    workspaceId: params.workspaceId,
    workspaceName: meta.name,
    isAdmin: meta.role === 'owner' || meta.role === 'admin',
    settings,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const form = await request.formData()
  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/settings`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ aiIndexingEnabled: form.get('aiIndexingEnabled') === 'on' }),
    },
  )
  if (res.ok) return { saved: true as const }
  return { error: friendlyError(res.status, 'updating the workspace settings') }
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, isAdmin, settings } = loaderData
  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : false

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
      </header>

      <p className="lede">How this workspace's data is handled.</p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && <StatusNote>Settings saved.</StatusNote>}

      <h2>Data & AI</h2>

      <Callout tone="ok" className="mt-3 max-w-[68ch]">
        Secrets are never indexed. They are excluded from embedding entirely, so no secret value can
        reach a model through search or the assistant — independent of the setting below.
      </Callout>

      {!isAdmin && <Forbidden subject="change workspace settings" />}

      <Form method="post" className="mt-6 flex max-w-2xl flex-col gap-1">
        <div className="policy-row">
          <div className="policy-head">
            <Checkbox
              id="aiIndexingEnabled"
              name="aiIndexingEnabled"
              defaultChecked={settings.aiIndexingEnabled}
              disabled={!isAdmin}
              aria-describedby="aiIndexingEnabled-desc"
            />
            <label htmlFor="aiIndexingEnabled" className="policy-label">
              Index configuration for semantic search
            </label>
          </div>
          <p id="aiIndexingEnabled-desc" className="policy-body">
            Config, flag, and content values in this workspace are embedded so that search and the
            assistant can find them by meaning rather than exact key. Turning this off stops new
            writes from being indexed and makes semantic search return nothing for this workspace;
            exact-key lookups and the delivery plane are unaffected.
          </p>
          <p className="policy-mech">
            <span className="policy-mech-key">Enforced at</span> the indexing and search paths in
            the api — a disabled workspace is never embedded and never queried
          </p>
        </div>

        {isAdmin && (
          <Button type="submit" className="mt-4 self-start">
            Save settings
          </Button>
        )}
      </Form>
    </section>
  )
}
