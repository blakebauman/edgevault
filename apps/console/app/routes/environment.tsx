import { useEffect, useRef, useState } from 'react'
import { Form, Link, redirect, useNavigation, useSearchParams } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { formatTime } from '../lib/format'
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

  const [workspaceName, envsRes, configsRes] = await Promise.all([
    getWorkspaceName(env, token, params.workspaceId),
    api(env, token, `${base}/environments`),
    api(env, token, `${base}/environments/${params.envId}/configs`),
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
    else revealError = `Reveal failed (${res.status}).`
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
      return { error: body?.detail ?? body?.error ?? `Save failed (${res.status})` }
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
    return res.ok ? { deleted: key } : { error: `Delete failed (${res.status})` }
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
    if (!res.ok) return { error: `Key creation failed (${res.status})` }
    const { apiKey } = (await res.json()) as { apiKey: string }
    return { mintedKey: apiKey }
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
      return { error: body?.detail ?? `Revert failed (${res.status})` }
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
    revealed,
    revealError,
    historyKey,
    revisions,
  } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const [searchParams] = useSearchParams()
  const [editing, setEditing] = useState<ConfigRow | null>(null)

  const error = actionData && 'error' in actionData ? actionData.error : null
  const saved = actionData && 'saved' in actionData ? actionData.saved : null
  const deleted = actionData && 'deleted' in actionData ? actionData.deleted : null
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
            <p className="eyebrow">Environment</p>
            <h1>
              {workspaceName ?? workspaceId} <span className="muted">{envName}</span>
            </h1>
            <span className="page-id">
              <CopyButton value={envId} label="Copy environment id" />
            </span>
          </div>
          <div className="org-links">
            <Link to={`/dashboard/${workspaceId}`} className="secondary button">
              ← Workspace
            </Link>
          </div>
        </header>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="status-note" role="status">
            Saved "{saved.key}" — now v{saved.version}, live at the edge in seconds.
          </p>
        )}
        {deleted && (
          <p className="status-note" role="status">
            Deleted "{deleted}".
          </p>
        )}
        {reverted && (
          <p className="status-note" role="status">
            Reverted — a new revision now carries the old content.
          </p>
        )}
        {revealError && (
          <p className="error-text" role="alert">
            {revealError}
          </p>
        )}

        {mintedKey && (
          <div className="token-box">
            <p className="token-note">
              API key — copy it now, it won't be shown again. Use it as{' '}
              <code>EDGEVAULT_API_KEY</code> (CLI) or <code>apiKey</code> (SDK).
            </p>
            <div className="token-row">
              <code className="token-value">{mintedKey}</code>
              <CopyButton value={mintedKey} label="Copy key" />
            </div>
          </div>
        )}

        {revealed && (
          <div className="token-box">
            <p className="token-note">
              Secret "{revealed.key}" — this reveal was logged to the audit trail.
            </p>
            <div className="token-row">
              <code className="token-value">{revealed.content}</code>
              <CopyButton value={revealed.content} label="Copy value" />
            </div>
          </div>
        )}

        <h2>Items</h2>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern) */}
        <section className="table-scroll" aria-label="Items" tabIndex={0}>
          <table className="compare-table cards-sm">
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Version</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configs.map((item) => (
                <tr key={item.key}>
                  <td className="mono">{item.key}</td>
                  <td data-label="Kind">
                    <span className={`status kind-${item.kind}`}>{item.kind}</span>
                  </td>
                  <td className="muted" data-label="Version">
                    v{item.version}
                  </td>
                  <td className="muted" data-label="Updated">
                    {formatTime(item.updatedAt)}
                  </td>
                  <td>
                    <ItemActions
                      item={item}
                      busy={busy}
                      baseSearch={baseSearch}
                      onEdit={() => setEditing(item)}
                    />
                  </td>
                </tr>
              ))}
              {configs.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Nothing here yet — add your first config, flag, or secret below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {historyKey && revisions && (
          <>
            <h2>
              History · <span className="mono">{historyKey}</span>{' '}
              <Link to={baseSearch({})} className="muted">
                (close)
              </Link>
            </h2>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region; keyboard users need focus to scroll it (WAI pattern) */}
            <section className="table-scroll" aria-label="Revision history" tabIndex={0}>
              <table className="compare-table cards-sm">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Change</th>
                    <th>Summary</th>
                    <th>By</th>
                    <th>At</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((rev) => (
                    <tr key={rev.id}>
                      <td className="muted" data-label="Version">
                        v{rev.version}
                      </td>
                      <td data-label="Change">
                        <span className="status chip-neutral">{rev.changeType}</span>
                      </td>
                      <td className="muted" data-label="Summary">
                        {rev.summary ?? '—'}
                      </td>
                      <td className="muted" data-label="By">
                        {rev.actor ?? <span className="mono">{rev.createdBy.slice(0, 8)}</span>}
                      </td>
                      <td className="muted" data-label="At">
                        {formatTime(rev.createdAt)}
                      </td>
                      <td>
                        <RevertControl revisionId={rev.id} version={rev.version} busy={busy} />
                      </td>
                    </tr>
                  ))}
                  {revisions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No revisions recorded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
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
        <p className="muted">
          Keys are environment-scoped and shown once. <code className="mono">read</code> serves
          configs and flags; <code className="mono">secrets:read</code> additionally lets{' '}
          <code className="mono">edgevault run</code> inject secrets (admin-only to mint).
        </p>
        <Form method="post" className="form">
          <input type="hidden" name="intent" value="mint-key" />
          <label>
            Key name
            <input type="text" name="name" required placeholder="e.g. production server" />
          </label>
          <fieldset className="event-filter">
            <legend className="muted">Scopes</legend>
            <label className="check">
              <input type="checkbox" name="scopes" value="read" defaultChecked /> read
            </label>
            <label className="check">
              <input type="checkbox" name="scopes" value="secrets:read" /> secrets:read
            </label>
          </fieldset>
          <button type="submit" disabled={busy}>
            {busy ? 'Minting…' : 'Mint API key'}
          </button>
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
  const contentRef = useRef<HTMLTextAreaElement>(null)

  // "Edit" lives in the table; the form lives below it. Carry the user there —
  // scroll and focus the value they came to change.
  useEffect(() => {
    if (editing) {
      contentRef.current?.scrollIntoView({ block: 'center' })
      contentRef.current?.focus()
    }
  }, [editing])

  return (
    <Form method="post" className="form item-form" onSubmit={onDone}>
      <input type="hidden" name="intent" value="save" />
      <label>
        Key
        <input
          type="text"
          name="key"
          required
          defaultValue={editing?.key ?? ''}
          placeholder="e.g. checkout-timeout-ms"
        />
      </label>
      <div className="row">
        <label>
          Kind
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="config">config</option>
            <option value="flag">flag</option>
            <option value="secret">secret</option>
          </select>
        </label>
        <label>
          Format
          <select name="contentType" defaultValue={editing?.contentType ?? 'json'}>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field-hint">{KIND_HINT[kind]}</p>
      <label>
        Value
        <textarea
          ref={contentRef}
          name="content"
          required
          rows={4}
          defaultValue={editing && editing.kind !== 'secret' ? editing.content : ''}
          placeholder={kind === 'flag' ? '{"enabled": true, "rollout": 0.25}' : ''}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save new version' : 'Save'}
        </button>
        {editing && (
          <button type="button" className="secondary" onClick={onDone}>
            Cancel edit
          </button>
        )}
      </div>
    </Form>
  )
}

/** The row's action group. Arming a delete replaces the WHOLE group (same
 * height, no sibling reflow) — and the confirm never lands where Delete was,
 * so a double-click can't fall through to it. Deleting breaks consumers
 * immediately and (if referenced) the API refuses; it gets the danger voice. */
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
      <div className="confirm-row">
        <p className="confirm-note">Delete "{item.key}"?</p>
        <Form method="post" onSubmit={() => setArming(false)}>
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="key" value={item.key} />
          <button type="submit" className="danger compact" disabled={busy}>
            Confirm delete
          </button>
        </Form>
        <button type="button" className="secondary compact" onClick={() => setArming(false)}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="row">
      {item.kind !== 'secret' && (
        <button type="button" className="secondary compact" onClick={onEdit}>
          Edit
        </button>
      )}
      <Link className="secondary button compact" to={baseSearch({ history: item.key })}>
        History
      </Link>
      {item.kind === 'secret' && (
        <Link className="secondary button compact" to={baseSearch({ reveal: item.key })}>
          Reveal
        </Link>
      )}
      <button
        type="button"
        className="secondary compact"
        disabled={busy}
        onClick={() => setArming(true)}
      >
        Delete
      </button>
    </div>
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
  const [arming, setArming] = useState(false)

  if (!arming) {
    return (
      <button
        type="button"
        className="secondary compact"
        disabled={busy}
        onClick={() => setArming(true)}
      >
        Revert
      </button>
    )
  }

  return (
    <div className="confirm-row">
      <p className="confirm-note">Replace the current value with v{version}?</p>
      <Form method="post" onSubmit={() => setArming(false)}>
        <input type="hidden" name="intent" value="revert" />
        <input type="hidden" name="revisionId" value={revisionId} />
        <button type="submit" className="danger compact" disabled={busy}>
          Confirm revert
        </button>
      </Form>
      <button type="button" className="secondary compact" onClick={() => setArming(false)}>
        Cancel
      </button>
    </div>
  )
}
