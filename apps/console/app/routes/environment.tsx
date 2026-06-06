import {
  ActionGroup,
  Button,
  CardTable,
  Checkbox,
  Chip,
  ErrorNote,
  Field,
  Input,
  Select,
  StatusNote,
  Td,
  Textarea,
  Th,
  TokenBox,
  TokenValue,
  TwoStepConfirm,
} from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'
import { Form, Link, redirect, useNavigation, useSearchParams } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { Crumbs } from '../components/crumbs'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import { getWorkspaceName } from '../lib/workspace.server'
import type { Route } from './+types/environment'

/**
 * The core surface: manage an environment's configs, flags, and secrets.
 * Create/update (validated + envelope-encrypted server-side), delete (with
 * reference protection), audited secret reveal, revision history with revert,
 * and environment API-key minting (shown exactly once).
 */

const CONTENT_TYPES = ['json', 'yaml', 'xml', 'ini', 'toml', 'properties', 'csv', 'text'] as const

type ConfigRow = {
  key: string
  kind: 'config' | 'flag' | 'secret'
  contentType: string
  content: string
  version: number
  updatedAt: number
  updatedBy: string
}

type DeletedRow = { key: string; kind: string | null; deletedAt: number }

type Revision = {
  id: string
  key: string
  content: string
  version: number
  changeType: string
  summary: string | null
  createdAt: number
  createdBy: string
  actor: string | null
}

export function meta({ data }: Route.MetaArgs) {
  return [
    {
      title: `${data?.envName ?? 'Environment'} · ${data?.workspaceName ?? 'Workspace'} · EdgeVault`,
    },
  ]
}

function api(env: Env, token: string, path: string, init?: RequestInit) {
  return env.API_SERVICE.fetch(`https://api/api/v1/workspaces${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  })
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `/${params.workspaceId}`

  const url = new URL(request.url)
  const revealKey = url.searchParams.get('reveal')
  const historyKey = url.searchParams.get('history')

  const [workspaceName, envsRes, configsRes, deletedRes] = await Promise.all([
    getWorkspaceName(env, token, params.workspaceId),
    api(env, token, `${base}/environments`),
    api(env, token, `${base}/environments/${params.envId}/configs`),
    api(env, token, `${base}/environments/${params.envId}/deleted-configs`),
  ])
  if (envsRes.status === 401 || configsRes.status === 401) throw redirect('/login')

  const environments = envsRes.ok
    ? (
        (await envsRes.json()) as {
          environments: Array<{ id: string; name: string; slug: string }>
        }
      ).environments
    : []
  const environment = environments.find((e) => e.id === params.envId)
  const configs = configsRes.ok
    ? ((await configsRes.json()) as { configs: ConfigRow[] }).configs
    : []
  const deletedConfigs = deletedRes.ok
    ? ((await deletedRes.json()) as { deleted: DeletedRow[] }).deleted
    : []

  // Audited, admin-gated secret reveal — proxied here so the browser never
  // holds the bearer token. Triggered by ?reveal=<key>.
  let revealed: { key: string; content: string } | null = null
  let revealError: string | null = null
  if (revealKey) {
    const res = await api(
      env,
      token,
      `${base}/environments/${params.envId}/configs/${encodeURIComponent(revealKey)}/reveal`,
    )
    if (res.ok) revealed = (await res.json()) as { key: string; content: string }
    else if (res.status === 403) revealError = 'Revealing secrets requires an org owner or admin.'
    else revealError = friendlyError(res.status, 'revealing the secret')
  }

  let revisions: Revision[] | null = null
  if (historyKey) {
    const res = await api(
      env,
      token,
      `${base}/environments/${params.envId}/configs/${encodeURIComponent(historyKey)}/revisions`,
    )
    if (res.ok) revisions = ((await res.json()) as { revisions: Revision[] }).revisions
  }

  return {
    workspaceId: params.workspaceId,
    envId: params.envId,
    workspaceName,
    envName: environment ? `${environment.name} /${environment.slug}` : params.envId,
    configs,
    deletedConfigs,
    revealed,
    revealError,
    historyKey,
    revisions,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `/${params.workspaceId}`
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'save') {
    const res = await api(env, token, `${base}/environments/${params.envId}/configs`, {
      method: 'POST',
      body: JSON.stringify({
        key: String(form.get('key') ?? '').trim(),
        kind: String(form.get('kind') ?? 'config'),
        content: String(form.get('content') ?? ''),
        contentType: String(form.get('contentType') ?? 'json'),
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        detail?: string
        error?: string
      } | null
      return { error: body?.detail ?? body?.error ?? friendlyError(res.status, 'saving') }
    }
    const { config } = (await res.json()) as { config: { key: string; version: number } }
    return { saved: { key: config.key, version: config.version } }
  }

  if (intent === 'delete') {
    const key = String(form.get('key'))
    const res = await api(
      env,
      token,
      `${base}/environments/${params.envId}/configs/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    )
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null
      return { error: body?.detail ?? 'Other configs still reference this key.' }
    }
    return res.ok ? { deleted: key } : { error: friendlyError(res.status, 'deleting') }
  }

  if (intent === 'mint-key') {
    const scopes = form.getAll('scopes').map(String)
    const res = await api(env, token, `${base}/environments/${params.envId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: String(form.get('name') ?? '').trim(),
        scopes: scopes.length ? scopes : ['read'],
      }),
    })
    if (res.status === 403) {
      return { error: 'Keys with secrets:read require an org owner or admin.' }
    }
    if (!res.ok) return { error: friendlyError(res.status, 'minting the key') }
    const { apiKey } = (await res.json()) as { apiKey: string }
    return { mintedKey: apiKey }
  }

  if (intent === 'bulk-delete') {
    const keys = String(form.get('keys') ?? '')
      .split('\n')
      .filter(Boolean)
    let deleted = 0
    const failures: string[] = []
    // Sequential on purpose: each delete validates references against the
    // post-state of the previous one.
    for (const key of keys) {
      const res = await api(
        env,
        token,
        `${base}/environments/${params.envId}/configs/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      )
      if (res.ok) deleted += 1
      else if (res.status === 409) failures.push(`"${key}" is still referenced`)
      else failures.push(`"${key}" failed`)
    }
    return { bulkDeleted: { count: deleted, failures } }
  }

  if (intent === 'restore') {
    const key = String(form.get('key'))
    const res = await api(
      env,
      token,
      `${base}/environments/${params.envId}/configs/${encodeURIComponent(key)}/restore`,
      { method: 'POST', body: JSON.stringify({}) },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null
      return { error: body?.detail ?? friendlyError(res.status, 'restoring') }
    }
    const { config } = (await res.json()) as { config: { key: string; version: number } }
    return { restored: { key: config.key, version: config.version } }
  }

  if (intent === 'revert') {
    const res = await api(
      env,
      token,
      `${base}/revisions/${String(form.get('revisionId'))}/revert`,
      { method: 'POST', body: JSON.stringify({}) },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null
      return { error: body?.detail ?? friendlyError(res.status, 'reverting') }
    }
    return { reverted: true }
  }

  return { error: 'Unknown action' }
}

const KIND_HINT: Record<string, string> = {
  config: 'Plain configuration — served from the edge, indexed for search.',
  flag: 'Feature flag — booleans, percentages, or JSON; SDK flag() reads these.',
  secret: 'Envelope-encrypted before storage. The value is shown only via an audited reveal.',
}

export default function Environment({ loaderData, actionData }: Route.ComponentProps) {
  const {
    workspaceId,
    envId,
    workspaceName,
    envName,
    configs,
    deletedConfigs,
    revealed,
    revealError,
    historyKey,
    revisions,
  } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const [searchParams] = useSearchParams()
  const [editing, setEditing] = useState<ConfigRow | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : null
  const deleted = actionData && 'deleted' in actionData ? actionData.deleted : null
  const restored = actionData && 'restored' in actionData ? actionData.restored : null
  const bulkDeleted = actionData && 'bulkDeleted' in actionData ? actionData.bulkDeleted : null
  const mintedKey = actionData && 'mintedKey' in actionData ? actionData.mintedKey : null
  const reverted = actionData && 'reverted' in actionData ? actionData.reverted : false

  const baseSearch = (extra: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    next.delete('reveal')
    next.delete('history')
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    const qs = next.toString()
    return qs ? `?${qs}` : '.'
  }

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <Crumbs
              items={[
                { label: 'workspaces', to: '/' },
                { label: workspaceName ?? 'workspace', to: `/dashboard/${workspaceId}` },
                { label: envName },
              ]}
            />
            <p className="eyebrow">Environment</p>
            <h1>
              {workspaceName ?? workspaceId}{' '}
              <span className="text-muted-foreground">{envName}</span>
            </h1>
            <span className="page-id">
              <CopyButton value={envId} label="Copy environment id" />
            </span>
          </div>
        </header>

        {error && <ErrorNote>{error}</ErrorNote>}
        {saved && (
          <StatusNote>
            Saved "{saved.key}" — now v{saved.version}, live at the edge in seconds.
          </StatusNote>
        )}
        {deleted && (
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <StatusNote>Deleted "{deleted}".</StatusNote>
            <Form method="post">
              <input type="hidden" name="intent" value="restore" />
              <input type="hidden" name="key" value={deleted} />
              <Button type="submit" variant="linklike" size="compact" disabled={busy}>
                Undo — restore it
              </Button>
            </Form>
          </div>
        )}
        {restored && (
          <StatusNote>
            Restored "{restored.key}" — now v{restored.version}, live at the edge in seconds.
          </StatusNote>
        )}
        {bulkDeleted && (
          <StatusNote>
            Deleted {bulkDeleted.count} key{bulkDeleted.count === 1 ? '' : 's'} — restorable from
            Recently deleted below.
          </StatusNote>
        )}
        {bulkDeleted && bulkDeleted.failures.length > 0 && (
          <ErrorNote>Not deleted: {bulkDeleted.failures.join('; ')}.</ErrorNote>
        )}
        {reverted && (
          <StatusNote>Reverted — a new revision now carries the old content.</StatusNote>
        )}
        {revealError && <ErrorNote>{revealError}</ErrorNote>}

        {mintedKey && (
          <TokenBox
            className="mt-6"
            note={
              <>
                API key — copy it now, it won't be shown again. Use it as{' '}
                <code>EDGEVAULT_API_KEY</code> (CLI) or <code>apiKey</code> (SDK).
              </>
            }
          >
            <TokenValue>{mintedKey}</TokenValue>
            <CopyButton value={mintedKey} label="Copy key" />
          </TokenBox>
        )}

        {revealed && (
          <TokenBox
            className="mt-6"
            note={<>Secret "{revealed.key}" — this reveal was logged to the audit trail.</>}
          >
            <TokenValue>{revealed.content}</TokenValue>
            <CopyButton value={revealed.content} label="Copy value" />
          </TokenBox>
        )}

        <h2>Items</h2>
        {selected.size > 0 && (
          <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <TwoStepConfirm
              trigger="Delete selected"
              disabled={busy}
              note={`Delete ${selected.size} key${selected.size === 1 ? '' : 's'} from this environment?`}
            >
              {(close) => (
                <Form
                  method="post"
                  onSubmit={() => {
                    close()
                    setSelected(new Set())
                  }}
                >
                  <input type="hidden" name="intent" value="bulk-delete" />
                  <input type="hidden" name="keys" value={[...selected].join('\n')} />
                  <Button type="submit" variant="danger" size="compact" disabled={busy}>
                    Confirm delete {selected.size}
                  </Button>
                </Form>
              )}
            </TwoStepConfirm>
            <Button
              type="button"
              variant="linklike"
              size="compact"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        )}
        <CardTable label="Items">
          <thead>
            <tr>
              <Th aria-label="Select" />
              <Th>Key</Th>
              <Th>Kind</Th>
              <Th>Version</Th>
              <Th>Updated</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {configs.map((item) => (
              <tr key={item.key}>
                <Td>
                  <Checkbox
                    checked={selected.has(item.key)}
                    onChange={() => toggle(item.key)}
                    aria-label={`Select ${item.key}`}
                  />
                </Td>
                <Td className="font-mono text-sm">{item.key}</Td>
                <Td label="Kind">
                  <Chip variant={`kind-${item.kind}`}>{item.kind}</Chip>
                </Td>
                <Td label="Version" className="text-muted-foreground">
                  v{item.version}
                </Td>
                <Td label="Updated" className="text-muted-foreground">
                  <LocalTime epoch={item.updatedAt} />
                </Td>
                <Td>
                  <ItemActions
                    item={item}
                    busy={busy}
                    baseSearch={baseSearch}
                    onEdit={() => setEditing(item)}
                  />
                </Td>
              </tr>
            ))}
            {configs.length === 0 && (
              <tr>
                <Td colSpan={6} className="text-muted-foreground">
                  Nothing here yet. Add your first config, flag, or secret below — it's live at the
                  edge seconds after saving. Then mint an API key (bottom of the page) and read it
                  from your code with the SDK or CLI.
                </Td>
              </tr>
            )}
          </tbody>
        </CardTable>

        {deletedConfigs.length > 0 && (
          <details className="create-inline">
            <summary>
              Recently deleted ({deletedConfigs.length}) — restorable from revision history
            </summary>
            <ul className="feed mt-3" aria-label="Recently deleted keys">
              {deletedConfigs.map((d) => (
                <li key={d.key} className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm">{d.key}</span>
                  {d.kind && (
                    <Chip variant={`kind-${d.kind as 'config' | 'flag' | 'secret'}`}>{d.kind}</Chip>
                  )}
                  <span className="text-xs text-muted-foreground">
                    deleted <LocalTime epoch={d.deletedAt} />
                  </span>
                  <Form method="post">
                    <input type="hidden" name="intent" value="restore" />
                    <input type="hidden" name="key" value={d.key} />
                    <Button type="submit" variant="secondary" size="compact" disabled={busy}>
                      Restore
                    </Button>
                  </Form>
                  <Button variant="linklike" size="compact" asChild>
                    <Link to={baseSearch({ history: d.key })}>History</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}

        {historyKey && revisions && (
          <>
            <h2>
              History · <span className="font-mono">{historyKey}</span>{' '}
              <Link to={baseSearch({})} className="text-muted-foreground">
                (close)
              </Link>
            </h2>
            <CardTable label="Revision history">
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Change</Th>
                  <Th>Summary</Th>
                  <Th>By</Th>
                  <Th>At</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {revisions.map((rev) => (
                  <tr key={rev.id}>
                    <Td label="Version" className="text-muted-foreground">
                      v{rev.version}
                    </Td>
                    <Td label="Change">
                      <Chip variant="neutral">{rev.changeType}</Chip>
                    </Td>
                    <Td label="Summary" className="text-muted-foreground">
                      {rev.summary ?? '—'}
                    </Td>
                    <Td label="By" className="text-muted-foreground">
                      {rev.actor ?? <span className="font-mono">{rev.createdBy.slice(0, 8)}</span>}
                    </Td>
                    <Td label="At" className="text-muted-foreground">
                      <LocalTime epoch={rev.createdAt} />
                    </Td>
                    <Td>
                      <RevertControl revisionId={rev.id} version={rev.version} busy={busy} />
                    </Td>
                  </tr>
                ))}
                {revisions.length === 0 && (
                  <tr>
                    <Td colSpan={6} className="text-muted-foreground">
                      No revisions recorded.
                    </Td>
                  </tr>
                )}
              </tbody>
            </CardTable>
          </>
        )}

        <h2>{editing ? `Edit "${editing.key}"` : 'Add a config, flag, or secret'}</h2>
        <ItemForm
          key={editing?.key ?? 'new'}
          editing={editing}
          busy={busy}
          onDone={() => setEditing(null)}
        />

        <h2>Environment API keys</h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Keys are environment-scoped and shown once. <code className="font-mono">read</code> serves
          configs and flags; <code className="font-mono">secrets:read</code> additionally lets{' '}
          <code className="font-mono">edgevault run</code> inject secrets (admin-only to mint).
        </p>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          <input type="hidden" name="intent" value="mint-key" />
          <Field label="Key name">
            <Input type="text" name="name" required placeholder="e.g. production server" />
          </Field>
          <fieldset className="grid gap-1.5 rounded-sm border border-input p-3">
            <legend className="text-muted-foreground">Scopes</legend>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders a native input inside the label */}
            <label className="flex items-center gap-2 font-mono text-xs">
              <Checkbox name="scopes" value="read" defaultChecked /> read
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders a native input inside the label */}
            <label className="flex items-center gap-2 font-mono text-xs">
              <Checkbox name="scopes" value="secrets:read" /> secrets:read
            </label>
          </fieldset>
          <Button type="submit" disabled={busy} className="self-start">
            {busy ? 'Minting…' : 'Mint API key'}
          </Button>
        </Form>
      </section>
    </main>
  )
}

function ItemForm({
  editing,
  busy,
  onDone,
}: {
  editing: ConfigRow | null
  busy: boolean
  onDone: () => void
}) {
  const [kind, setKind] = useState<string>(editing?.kind ?? 'config')
  const [clientError, setClientError] = useState<string | null>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  // "Edit" lives in the table; the form lives below it. Carry the user there —
  // scroll and focus the value they came to change.
  useEffect(() => {
    if (editing) {
      contentRef.current?.scrollIntoView({ block: 'center' })
      contentRef.current?.focus()
    }
  }, [editing])

  // Catch malformed JSON before the round-trip — the server still validates.
  function validate(e: React.FormEvent<HTMLFormElement>) {
    const data = new FormData(e.currentTarget)
    if (String(data.get('contentType')) === 'json') {
      try {
        JSON.parse(String(data.get('content')))
      } catch {
        e.preventDefault()
        setClientError("That isn't valid JSON — check for a missing quote, comma, or brace.")
        return
      }
    }
    setClientError(null)
    onDone()
  }

  return (
    <Form method="post" className="mt-6 flex max-w-xl flex-col gap-3" onSubmit={validate}>
      <input type="hidden" name="intent" value="save" />
      <Field label="Key">
        <Input
          type="text"
          name="key"
          required
          defaultValue={editing?.key ?? ''}
          placeholder="e.g. checkout-timeout-ms"
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Kind">
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="config">config</option>
            <option value="flag">flag</option>
            <option value="secret">secret</option>
          </Select>
        </Field>
        <Field label="Format">
          <Select name="contentType" defaultValue={editing?.contentType ?? 'json'}>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{KIND_HINT[kind]}</p>
      <Field label="Value">
        <Textarea
          ref={contentRef}
          name="content"
          required
          rows={4}
          defaultValue={editing && editing.kind !== 'secret' ? editing.content : ''}
          placeholder={kind === 'flag' ? '{"enabled": true, "rollout": 0.25}' : ''}
        />
      </Field>
      {clientError && <ErrorNote>{clientError}</ErrorNote>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save new version' : 'Save'}
        </Button>
        {editing && (
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel edit
          </Button>
        )}
      </div>
    </Form>
  )
}

/** The row's action group. Arming the delete replaces the WHOLE group (same
 * height, no sibling reflow — TwoStepConfirm's contract). Deleting breaks
 * consumers immediately and (if referenced) the API refuses; danger voice. */
function ItemActions({
  item,
  busy,
  baseSearch,
  onEdit,
}: {
  item: ConfigRow
  busy: boolean
  baseSearch: (extra: Record<string, string>) => string
  onEdit: () => void
}) {
  const [arming, setArming] = useState(false)

  if (arming) {
    return (
      <div className="flex min-h-8 flex-nowrap items-center gap-2 max-sm:flex-wrap">
        <p className="m-0 text-xs text-warn">Delete "{item.key}"?</p>
        <Form method="post" onSubmit={() => setArming(false)}>
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="key" value={item.key} />
          <Button type="submit" variant="danger" size="compact" disabled={busy}>
            Confirm delete
          </Button>
        </Form>
        <Button type="button" variant="secondary" size="compact" onClick={() => setArming(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <ActionGroup>
      {item.kind !== 'secret' && (
        <Button type="button" variant="secondary" size="compact" onClick={onEdit}>
          Edit
        </Button>
      )}
      <Button variant="secondary" size="compact" asChild>
        <Link to={baseSearch({ history: item.key })}>History</Link>
      </Button>
      {item.kind === 'secret' && (
        <Button variant="secondary" size="compact" asChild>
          <Link to={baseSearch({ reveal: item.key })}>Reveal</Link>
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        size="compact"
        disabled={busy}
        onClick={() => setArming(true)}
      >
        Delete
      </Button>
    </ActionGroup>
  )
}

/** Revert overwrites the current value (as a new revision) — danger voice. */
function RevertControl({
  revisionId,
  version,
  busy,
}: {
  revisionId: string
  version: number
  busy: boolean
}) {
  return (
    <TwoStepConfirm
      trigger="Revert"
      disabled={busy}
      note={`Replace the current value with v${version}?`}
    >
      {(close) => (
        <Form method="post" onSubmit={close}>
          <input type="hidden" name="intent" value="revert" />
          <input type="hidden" name="revisionId" value={revisionId} />
          <Button type="submit" variant="danger" size="compact" disabled={busy}>
            Confirm revert
          </Button>
        </Form>
      )}
    </TwoStepConfirm>
  )
}
