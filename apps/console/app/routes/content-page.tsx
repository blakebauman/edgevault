import {
  type BlockNode,
  blockResolverFromMap,
  parseDocument,
  RenderError,
  renderDocument,
} from '@edgevault/blocks'
import { useWorkspaceEvents } from '@edgevault/realtime/react'
import { Button, ErrorNote, Field, StatusNote, Textarea } from '@edgevault/ui'
import { useMemo, useState } from 'react'
import { Form, Link, redirect, useNavigation, useRevalidator } from 'react-router'
import { Crumbs } from '../components/crumbs'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/content-page'

/**
 * Content page authoring: edit a `content` document (an ordered list of blocks)
 * with a live HTML preview rendered by the SAME `@edgevault/blocks` registry the
 * publish step uses — so what you see is what delivery serves. The preview
 * resolves `${block.key}` references from the environment's other content items
 * and re-renders on every keystroke; realtime events refresh referenced blocks
 * edited elsewhere.
 */

const STARTER = JSON.stringify({ layout: 'page', blocks: [] }, null, 2)

type ContentItem = { key: string; content: string }

function api(env: Env, token: string, path: string, init?: RequestInit) {
  return env.API_SERVICE.fetch(`https://api/api/v1/workspaces${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
}

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.key} · page · EdgeVault` }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `/${params.workspaceId}`
  const key = decodeURIComponent(params.key)

  const [docRes, listRes] = await Promise.all([
    api(env, token, `${base}/environments/${params.envId}/configs/${encodeURIComponent(key)}`),
    api(env, token, `${base}/environments/${params.envId}/configs`),
  ])
  if (docRes.status === 401 || listRes.status === 401) throw redirect('/login')

  const documentContent = docRes.ok
    ? ((await docRes.json()) as { config: { content: string } }).config.content
    : STARTER

  // Every other content item in the environment is a candidate referenced block.
  const all = listRes.ok
    ? ((await listRes.json()) as { configs: Array<{ key: string; kind: string; content: string }> })
        .configs
    : []
  const blocks: ContentItem[] = all
    .filter((c) => c.kind === 'content' && c.key !== key)
    .map((c) => ({ key: c.key, content: c.content }))

  return {
    workspaceId: params.workspaceId,
    envId: params.envId,
    key,
    exists: docRes.ok,
    documentContent,
    blocks,
    wsUrl: `${env.API_WS_BASE}/api/v1/workspaces/${params.workspaceId}/ws?token=${encodeURIComponent(token)}`,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `/${params.workspaceId}`
  const form = await request.formData()
  const key = decodeURIComponent(params.key)
  const content = String(form.get('content') ?? '')

  // Surface malformed JSON before the server rejects it.
  try {
    parseDocument(content)
  } catch (error) {
    return { error: error instanceof RenderError ? error.message : 'Document is not valid JSON.' }
  }

  const res = await api(env, token, `${base}/environments/${params.envId}/configs`, {
    method: 'POST',
    body: JSON.stringify({ key, content, kind: 'content', contentType: 'json' }),
  })
  if (!res.ok) return { error: friendlyError(res.status, 'saving the page') }
  return redirect(
    `/dashboard/${params.workspaceId}/env/${params.envId}/pages/${encodeURIComponent(key)}`,
  )
}

/** Render the document to preview HTML, or return the render error to show. */
function preview(docText: string, blocks: ContentItem[]): { html: string; error: string | null } {
  try {
    const doc = parseDocument(docText)
    const nodes: Record<string, BlockNode> = {}
    for (const b of blocks) {
      try {
        nodes[b.key] = JSON.parse(b.content) as BlockNode
      } catch {
        // A malformed block surfaces as an unresolved reference below.
      }
    }
    return { html: renderDocument(doc, { resolveBlock: blockResolverFromMap(nodes) }), error: null }
  } catch (error) {
    if (error instanceof RenderError) return { html: '', error: `${error.code}: ${error.message}` }
    return { html: '', error: error instanceof Error ? error.message : String(error) }
  }
}

export default function ContentPage({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, envId, key, exists, documentContent, blocks, wsUrl } = loaderData
  const [docText, setDocText] = useState(documentContent)
  const busy = useNavigation().state !== 'idle'
  const revalidator = useRevalidator()

  // A referenced block edited elsewhere should refresh the preview.
  useWorkspaceEvents(wsUrl, (event) => {
    if (event.type === 'config.changed' || event.type === 'config.deleted') {
      revalidator.revalidate()
    }
  })

  const { html, error } = useMemo(() => preview(docText, blocks), [docText, blocks])

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <Crumbs
            items={[
              { label: 'workspace', to: `/dashboard/${workspaceId}` },
              { label: 'environment', to: `/dashboard/${workspaceId}/env/${envId}` },
              { label: key },
            ]}
          />
          <Button variant="secondary" size="compact" asChild>
            <Link to={`/dashboard/${workspaceId}/env/${envId}`}>Back to environment</Link>
          </Button>
        </header>

        {!exists && (
          <StatusNote>
            This page doesn't exist yet — saving creates it as a content item.
          </StatusNote>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Form method="post" className="flex flex-col gap-3">
            <Field label="Document (JSON)">
              <Textarea
                name="content"
                rows={20}
                value={docText}
                onChange={(e) => setDocText(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <p className="m-0 text-xs text-muted-foreground">
              A document is <code>{'{ "layout": "page", "blocks": [...] }'}</code>. Each block is an
              inline <code>{'{ "type", "props" }'}</code> or a <code>{'${block.key}'}</code>{' '}
              reference to another content item.
            </p>
            {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
            <div>
              <Button type="submit" loading={busy} disabled={error !== null}>
                Save &amp; publish
              </Button>
            </div>
          </Form>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Live preview</span>
            {error ? (
              <ErrorNote>{error}</ErrorNote>
            ) : (
              <iframe
                title="page preview"
                sandbox=""
                srcDoc={html}
                className="h-[28rem] w-full rounded-md border border-border bg-white"
              />
            )}
          </div>
        </div>
      </section>
    </main>
  )
}
