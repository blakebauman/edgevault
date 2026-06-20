import { Button, CardTable, ErrorNote, Field, Input, StatusNote, Td, Th } from '@edgevault/ui'
import { Form, Link, redirect, useNavigation } from 'react-router'
import { Crumbs } from '../components/crumbs'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/workspace.environments'

/**
 * Manage the workspace's environments — the named scopes (development, staging,
 * production) that every config, flag, secret, and content item lives inside.
 * Creating one is the entry point; opening one lands on its Config section.
 */

type EnvSummary = { id: string; name: string; slug: string }

export function meta() {
  return [{ title: 'Environments · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }
  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/environments`,
    { headers },
  )
  if (res.status === 401 || res.status === 403) throw redirect('/login')
  const environments = res.ok
    ? ((await res.json()) as { environments: EnvSummary[] }).environments
    : []
  return { workspaceId: params.workspaceId, environments }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const form = await request.formData()
  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/environments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: String(form.get('name') ?? '').trim(),
        slug: String(form.get('slug') ?? '').trim(),
      }),
    },
  )
  if (!res.ok) return { error: friendlyError(res.status, 'creating the environment') }
  return { created: true }
}

export default function Environments({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, environments } = loaderData
  const busy = useNavigation().state !== 'idle'

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <Crumbs
            items={[
              { label: 'workspaces', to: '/' },
              { label: 'workspace', to: `/dashboard/${workspaceId}` },
              { label: 'environments' },
            ]}
          />
          <p className="eyebrow">Workspace</p>
          <h1>Environments</h1>
        </div>
      </header>

      {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
      {actionData && 'created' in actionData && <StatusNote>Environment created.</StatusNote>}

      <CardTable label="Environments">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Slug</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {environments.map((e) => (
            <tr key={e.id}>
              <Td>
                <Link to={`/dashboard/${workspaceId}/env/${e.id}/config`}>{e.name}</Link>
              </Td>
              <Td label="Slug" className="font-mono text-sm text-muted-foreground">
                /{e.slug}
              </Td>
              <Td>
                <Button variant="secondary" size="compact" asChild>
                  <Link to={`/dashboard/${workspaceId}/env/${e.id}/config`}>Open →</Link>
                </Button>
              </Td>
            </tr>
          ))}
          {environments.length === 0 && (
            <tr>
              <Td colSpan={3} className="text-muted-foreground">
                No environments yet — the form below creates your first.
              </Td>
            </tr>
          )}
        </tbody>
      </CardTable>

      <h2>New environment</h2>
      <Form method="post" className="mt-4 flex max-w-xs flex-col gap-3">
        <Field label="Name">
          <Input type="text" name="name" required placeholder="Production" />
        </Field>
        <Field label="Slug">
          <Input type="text" name="slug" required placeholder="production" />
        </Field>
        <Button type="submit" className="self-start" loading={busy}>
          Create environment
        </Button>
      </Form>
    </section>
  )
}
