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
import { Form, Link, redirect, useFetcher, useNavigation, useSearchParams } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { Crumbs } from '../components/crumbs'
import { LocalTime } from '../components/local-time'
import { RevealField } from '../components/reveal-field'
import { StepUpPrompt } from '../components/step-up-prompt'
import { friendlyError } from '../lib/errors'
import { getRevealToken, getToken } from '../lib/session.server'
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
  kind: 'config' | 'flag' | 'secret' | 'content'
  contentType: string
  content: string
  version: number
  updatedAt: number
  updatedBy: string
}

type DeletedRow = { key: string; kind: string | null; deletedAt: number }

type ApiKeyRow = {
  id: string
  environmentId: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  allowedCidrs: string[]
  mine: boolean
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
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const base = `/${params.workspaceId}`

  const url = new URL(request.url)
  const historyKey = url.searchParams.get('history')

  const [workspaceName, envsRes, configsRes, deletedRes, keysRes] = await Promise.all([
    getWorkspaceName(env, token, params.workspaceId),
    api(env, token, `${base}/environments`),
    api(env, token, `${base}/environments/${params.envId}/configs`),
    api(env, token, `${base}/environments/${params.envId}/deleted-configs`),
    api(env, token, `${base}/api-keys`),
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
  const apiKeys = keysRes.ok
    ? ((await keysRes.json()) as { keys: ApiKeyRow[] }).keys.filter(
        (k) => k.environmentId === params.envId && !k.revokedAt,
      )
    : []

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
    apiKeys,
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
        summary: String(form.get('summary') ?? '').trim() || undefined,
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
    const expiresInDays = Number(form.get('expiresInDays') ?? 0)
    const allowedCidrs = String(form.get('allowedCidrs') ?? '')
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean)
    const res = await api(env, token, `${base}/environments/${params.envId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: String(form.get('name') ?? '').trim(),
        scopes: scopes.length ? scopes : ['read'],
        ...(expiresInDays > 0 ? { expiresInDays } : {}),
        ...(allowedCidrs.length ? { allowedCidrs } : {}),
      }),
    })
    if (res.status === 403) {
      return { error: 'Keys with secrets:read require an org owner or admin.' }
    }
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null
      return { error: body?.detail ?? 'Invalid key options.' }
    }
    if (!res.ok) return { error: friendlyError(res.status, 'minting the key') }
    const { apiKey } = (await res.json()) as { apiKey: string }
    return { mintedKey: apiKey }
  }

  if (intent === 'revoke-key') {
    const res = await api(env, token, `${base}/api-keys/${String(form.get('keyId'))}`, {
      method: 'DELETE',
    })
    return res.ok
      ? { keyRevoked: true as const }
      : { error: friendlyError(res.status, 'revoking the key') }
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

  if (intent === 'reveal') {
    // Audited, admin-gated. Proxied here so the browser never holds the bearer
    // token, and posted (not navigated) so the plaintext never lands in the URL,
    // browser history, or the server-rendered document — only in fetcher state.
    // If the org requires step-up, forward the httpOnly reveal token (minted at
    // /api/reveal-token after a fresh second factor); its absence/expiry comes
    // back as reauth_required, which the UI turns into a step-up prompt.
    const key = String(form.get('key'))
    const revealToken = getRevealToken(request)
    const res = await api(
      env,
      token,
      `${base}/environments/${params.envId}/configs/${encodeURIComponent(key)}/reveal`,
      revealToken ? { headers: { 'x-reveal-token': revealToken } } : undefined,
    )
    if (res.ok) return { revealed: (await res.json()) as { key: string; content: string } }
    if (res.status === 401) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === 'reauth_required') return { revealError: 'reauth_required' }
    }
    if (res.status === 403)
      return { revealError: 'Revealing secrets requires an org owner or admin.' }
    return { revealError: friendlyError(res.status, 'revealing the secret') }
  }

  if (intent === 'revert') {
    const res = await api(
      env,
      token,
      `${base}/revisions/${String(form.get('revisionId'))}/revert`,
      {
        method: 'POST',
        body: JSON.stringify({ summary: String(form.get('summary') ?? '').trim() || undefined }),
      },
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
  content:
    'Structured content — a document of blocks (or a reusable block) rendered to HTML at the edge.',
}

/**
 * A real, valid starting value per kind — the form pre-fills it so switching
 * kind teaches the shape instead of facing a blank box. Format tracks kind:
 * flags/content are JSON documents, secrets are opaque text, only config is
 * free-format. The value is only ever swapped in while it's still untouched.
 */
type ItemKind = ConfigRow['kind']
const ITEM_KINDS: readonly ItemKind[] = ['config', 'flag', 'secret', 'content']
const toKind = (s: string): ItemKind =>
  ITEM_KINDS.includes(s as ItemKind) ? (s as ItemKind) : 'config'

const SCAFFOLD: Record<ItemKind, { format: string; value: string }> = {
  config: { format: 'json', value: '{\n  "timeoutMs": 5000\n}' },
  flag: { format: 'json', value: '{\n  "enabled": true,\n  "rollout": 0.25\n}' },
  secret: { format: 'text', value: '' },
  content: { format: 'json', value: JSON.stringify({ layout: 'page', blocks: [] }, null, 2) },
}

/** config picks its own format; the other kinds have one natural format. */
const FORMAT_LOCKED: Record<ItemKind, boolean> = {
  config: false,
  flag: true,
  secret: true,
  content: true,
}

/** Time a revealed secret stays in memory before it's dropped automatically. */
const REVEAL_TTL_MS = 60_000

/**
 * Drives an audited secret reveal over a fetcher (POST, no navigation) so the
 * plaintext never touches the URL, history, or SSR document. The value is
 * mirrored into owned state we fully control: it auto-clears after a TTL and on
 * unmount (navigate), and a per-data-object guard stops the fetcher's lingering
 * result from re-populating after we've dropped it.
 */
function useReveal() {
  const fetcher = useFetcher<typeof action>()
  const [revealed, setRevealed] = useState<{ key: string; content: string } | null>(null)
  // The key awaiting a fresh step-up — drives the reauth prompt and the retry.
  const [needsStepUp, setNeedsStepUp] = useState<string | null>(null)
  const lastKey = useRef<string | null>(null)
  const seen = useRef<unknown>(null)

  const submit = (key: string) => {
    setRevealed(null)
    lastKey.current = key
    fetcher.submit({ intent: 'reveal', key }, { method: 'post' })
  }

  useEffect(() => {
    if (fetcher.data === seen.current) return
    seen.current = fetcher.data
    const data = fetcher.data
    if (!data) return
    if ('revealed' in data && data.revealed) {
      setRevealed(data.revealed)
      setNeedsStepUp(null)
    } else if ('revealError' in data && data.revealError === 'reauth_required') {
      setNeedsStepUp(lastKey.current)
    }
  }, [fetcher.data])

  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => setRevealed(null), REVEAL_TTL_MS)
    return () => clearTimeout(t)
  }, [revealed])

  const rawError = fetcher.data && 'revealError' in fetcher.data ? fetcher.data.revealError : null
  const error = revealed || needsStepUp || rawError === 'reauth_required' ? null : rawError

  return {
    revealed,
    needsStepUp,
    error,
    pending: fetcher.state !== 'idle',
    pendingKey: lastKey.current,
    reveal: submit,
    /** Re-run the reveal for the key that triggered step-up, now that a token exists. */
    retryStepUp: () => needsStepUp && submit(needsStepUp),
    cancelStepUp: () => setNeedsStepUp(null),
    clear: () => setRevealed(null),
  }
}

export default function Environment({ loaderData, actionData }: Route.ComponentProps) {
  const {
    workspaceId,
    envId,
    workspaceName,
    envName,
    configs,
    deletedConfigs,
    apiKeys,
    historyKey,
    revisions,
  } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const pendingIntent = navigation.formData?.get('intent')
  const reveal = useReveal()
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

  // Scope loading to the specific in-flight action, and fire the save button's
  // success ring on each new saved version. Non-secret keys are referenceable.
  const savingItem = busy && pendingIntent === 'save'
  const savedKey = saved ? `${saved.key}@${saved.version}` : undefined
  const referenceableKeys = configs.filter((c) => c.kind !== 'secret').map((c) => c.key)

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
        {reveal.error && <ErrorNote>{reveal.error}</ErrorNote>}

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
            <CopyButton value={mintedKey} label="Copy key" clearAfterMs={30_000} />
          </TokenBox>
        )}

        {reveal.needsStepUp && (
          <StepUpPrompt
            secretKey={reveal.needsStepUp}
            workspaceId={workspaceId}
            onSuccess={reveal.retryStepUp}
            onCancel={reveal.cancelStepUp}
          />
        )}

        {reveal.revealed && (
          <RevealField
            secretKey={reveal.revealed.key}
            value={reveal.revealed.content}
            onDismiss={reveal.clear}
          />
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
              <Th>
                <Checkbox
                  checked={selected.size === configs.length && configs.length > 0}
                  onChange={() =>
                    setSelected(
                      selected.size === configs.length
                        ? new Set()
                        : new Set(configs.map((c) => c.key)),
                    )
                  }
                  aria-label="Select all keys"
                />
              </Th>
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
                    revealing={reveal.pending && reveal.pendingKey === item.key}
                    baseSearch={baseSearch}
                    pageHref={`/dashboard/${workspaceId}/env/${envId}/pages/${encodeURIComponent(item.key)}`}
                    onEdit={() => setEditing(item)}
                    onReveal={() => reveal.reveal(item.key)}
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

        <h2>{editing ? `Edit "${editing.key}"` : 'Add a config, flag, secret, or page'}</h2>
        <ItemForm
          key={editing?.key ?? 'new'}
          editing={editing}
          loading={savingItem}
          successKey={savedKey}
          allKeys={referenceableKeys}
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
          <Field label="Expires after (days, optional)">
            <Input type="number" name="expiresInDays" min={1} max={365} placeholder="never" />
          </Field>
          <Field label="Allowed IPs / CIDRs (optional, comma-separated)">
            <Input type="text" name="allowedCidrs" placeholder="203.0.113.0/24, 2001:db8::/32" />
          </Field>
          <Button
            type="submit"
            loading={busy && pendingIntent === 'mint-key'}
            disabled={busy}
            className="self-start"
          >
            Mint API key
          </Button>
        </Form>

        {apiKeys.length > 0 && (
          <CardTable label="Active API keys" className="mt-6">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Prefix</Th>
                <Th>Scopes</Th>
                <Th>Expires</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((k) => (
                <tr key={k.id}>
                  <Td>{k.name}</Td>
                  <Td label="Prefix">
                    <span className="font-mono text-xs">{k.prefix}…</span>
                  </Td>
                  <Td label="Scopes" className="font-mono text-xs">
                    {k.scopes.join(', ')}
                    {k.allowedCidrs.length > 0 && (
                      <span className="text-muted-foreground"> · ip-restricted</span>
                    )}
                  </Td>
                  <Td label="Expires" className="text-muted-foreground">
                    <KeyExpiry expiresAt={k.expiresAt} />
                  </Td>
                  <Td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="revoke-key" />
                      <input type="hidden" name="keyId" value={k.id} />
                      <Button type="submit" variant="secondary" size="compact" disabled={busy}>
                        Revoke
                      </Button>
                    </Form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </CardTable>
        )}
      </section>
    </main>
  )
}

/** Expiry cell: plain date normally; a nudge once a key is 14 days from death. */
function KeyExpiry({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <>never</>
  const ms = Date.parse(expiresAt) - Date.now()
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  if (ms <= 0) return <span className="text-destructive">expired</span>
  if (days <= 14) {
    return (
      <span className="text-accent">
        in {days} day{days === 1 ? '' : 's'} — rotate soon
      </span>
    )
  }
  return <>{new Date(expiresAt).toLocaleDateString()}</>
}

function ItemForm({
  editing,
  loading,
  successKey,
  allKeys,
  onDone,
}: {
  editing: ConfigRow | null
  loading: boolean
  successKey?: string
  allKeys: string[]
  onDone: () => void
}) {
  const initialKind: ItemKind = editing?.kind ?? 'config'
  const [kind, setKind] = useState<string>(initialKind)
  const [format, setFormat] = useState<string>(editing?.contentType ?? SCAFFOLD[initialKind].format)
  const [value, setValue] = useState<string>(
    editing ? (editing.kind === 'secret' ? '' : editing.content) : SCAFFOLD[initialKind].value,
  )
  const [rawFlag, setRawFlag] = useState(false)
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

  // Switching kind re-points the format and swaps the example — but only while
  // the value is still a pristine scaffold, so typed content is never clobbered.
  function changeKind(raw: string) {
    const next = toKind(raw)
    // New items: format follows the kind's natural default and the example
    // swaps in — unless the user has already typed over the scaffold.
    if (!editing) {
      setFormat(SCAFFOLD[next].format)
      setValue((cur) =>
        cur.trim() === '' || cur === SCAFFOLD[toKind(kind)].value ? SCAFFOLD[next].value : cur,
      )
    } else if (FORMAT_LOCKED[next]) {
      setFormat(SCAFFOLD[next].format)
    }
    setKind(next)
    setClientError(null)
  }

  // Catch malformed JSON before the round-trip — the server validates every
  // format and returns a precise reason, so non-JSON falls through to it.
  function validate(e: React.FormEvent<HTMLFormElement>) {
    if (format === 'json') {
      try {
        JSON.parse(value)
      } catch {
        e.preventDefault()
        setClientError("That isn't valid JSON — check for a missing quote, comma, or brace.")
        return
      }
    }
    setClientError(null)
    onDone()
  }

  // Insert ${key} at the caret so references don't have to be recalled by hand.
  function insertRef(refKey: string) {
    const el = contentRef.current
    const token = `\${${refKey}}`
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    setValue(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      const caret = start + token.length
      el?.setSelectionRange(caret, caret)
    })
  }

  const showFlagEditor = kind === 'flag' && format === 'json' && !rawFlag
  const refKeys = allKeys.filter((k) => k !== editing?.key)
  const canReference = kind !== 'secret' && refKeys.length > 0

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
          <Select name="kind" value={kind} onChange={(e) => changeKind(e.target.value)}>
            <option value="config">config</option>
            <option value="flag">flag</option>
            <option value="secret">secret</option>
            <option value="content">content</option>
          </Select>
        </Field>
        {FORMAT_LOCKED[toKind(kind)] ? (
          <input type="hidden" name="contentType" value={format} />
        ) : (
          <Field label="Format">
            <Select name="contentType" value={format} onChange={(e) => setFormat(e.target.value)}>
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{KIND_HINT[kind]}</p>

      {showFlagEditor && (
        <FlagEditor value={value} onChange={setValue} onEditRaw={() => setRawFlag(true)} />
      )}
      <Field label="Value" className={showFlagEditor ? 'sr-only' : undefined}>
        <Textarea
          ref={contentRef}
          name="content"
          required
          rows={kind === 'content' ? 8 : 4}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          aria-hidden={showFlagEditor || undefined}
          tabIndex={showFlagEditor ? -1 : undefined}
        />
      </Field>

      {canReference && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Reference a key:</span>
          {refKeys.slice(0, 8).map((k) => (
            <Button
              key={k}
              type="button"
              variant="secondary"
              size="compact"
              className="font-mono"
              onClick={() => insertRef(k)}
            >
              {`\${${k}}`}
            </Button>
          ))}
        </div>
      )}

      <Field label="Reason (optional)">
        <Input type="text" name="summary" placeholder="Why this change? — shown in history" />
      </Field>

      {clientError && <ErrorNote>{clientError}</ErrorNote>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={loading} successKey={successKey}>
          {editing ? 'Save new version' : 'Save'}
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

/**
 * A flag is just JSON to the API, so this is a thin editor over the two fields
 * the SDK's flag() actually reads — an enabled toggle and a 0–100 rollout — with
 * a raw-JSON escape hatch. Targeting rules aren't enforced server-side yet, so
 * the editor stays deliberately small rather than implying more than ships.
 */
function FlagEditor({
  value,
  onChange,
  onEditRaw,
}: {
  value: string
  onChange: (next: string) => void
  onEditRaw: () => void
}) {
  let parsed: Record<string, unknown> | null = null
  try {
    const p = JSON.parse(value)
    if (p && typeof p === 'object' && !Array.isArray(p)) parsed = p as Record<string, unknown>
  } catch {
    parsed = null
  }

  // Hand-shaped JSON (arrays, custom keys) doesn't fit the toggle — send them
  // straight to the raw editor rather than flatten their intent.
  if (!parsed) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border p-3 text-xs text-muted-foreground">
        <span>This flag's shape is custom.</span>
        <Button type="button" variant="secondary" size="compact" onClick={onEditRaw}>
          Edit raw JSON
        </Button>
      </div>
    )
  }

  const enabled = parsed.enabled !== false
  const fraction = typeof parsed.rollout === 'number' ? parsed.rollout : 1
  const rolloutPct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  const emit = (patch: Record<string, unknown>) =>
    onChange(JSON.stringify({ ...parsed, ...patch }, null, 2))

  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border p-3">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox is the control, wrapped by the label */}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox checked={enabled} onChange={(e) => emit({ enabled: e.target.checked })} />
        <span>Enabled</span>
      </label>
      <Field label={`Rollout — ${rolloutPct}% of traffic`}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={rolloutPct}
          disabled={!enabled}
          onChange={(e) => emit({ rollout: Number(e.target.value) / 100 })}
          className="w-full accent-relay disabled:opacity-55"
          aria-label="Rollout percentage"
        />
      </Field>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <code className="truncate font-mono">{value.replace(/\s+/g, ' ')}</code>
        <Button type="button" variant="linklike" size="compact" onClick={onEditRaw}>
          Edit raw JSON
        </Button>
      </div>
    </div>
  )
}

/** The row's action group. Arming the delete replaces the WHOLE group (same
 * height, no sibling reflow — TwoStepConfirm's contract). Deleting breaks
 * consumers immediately and (if referenced) the API refuses; danger voice. */
function ItemActions({
  item,
  busy,
  revealing,
  baseSearch,
  pageHref,
  onEdit,
  onReveal,
}: {
  item: ConfigRow
  busy: boolean
  revealing: boolean
  baseSearch: (extra: Record<string, string>) => string
  pageHref: string
  onEdit: () => void
  onReveal: () => void
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
      {item.kind === 'content' && (
        <Button variant="secondary" size="compact" asChild>
          <Link to={pageHref}>Page</Link>
        </Button>
      )}
      <Button variant="secondary" size="compact" asChild>
        <Link to={baseSearch({ history: item.key })}>History</Link>
      </Button>
      {item.kind === 'secret' && (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={busy}
          loading={revealing}
          onClick={onReveal}
        >
          Reveal
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
        <Form method="post" onSubmit={close} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="revert" />
          <input type="hidden" name="revisionId" value={revisionId} />
          <Input
            type="text"
            name="summary"
            placeholder="reason (optional)"
            className="w-44 max-w-full"
            aria-label="Reason for revert"
          />
          <Button type="submit" variant="danger" size="compact" loading={busy}>
            Confirm revert
          </Button>
        </Form>
      )}
    </TwoStepConfirm>
  )
}
