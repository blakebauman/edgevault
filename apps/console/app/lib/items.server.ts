import { redirect } from 'react-router'
import { friendlyError } from './errors'
import { getRevealToken, getToken } from './session.server'

/**
 * Shared server logic for the per-type item sections (Config / Flags / Secrets /
 * Content). Each section route is a thin loader/action over these helpers — the kind
 * the section pins decides which list it fetches; every write goes through the
 * same audited `handleItemAction`.
 */

export type ItemKind = 'config' | 'flag' | 'secret' | 'content'

export type ConfigRow = {
  key: string
  kind: ItemKind
  contentType: string
  content: string
  version: number
  updatedAt: number
  updatedBy: string
}

export type DeletedRow = { key: string; kind: string | null; deletedAt: number }

export type ApiKeyRow = {
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

export type Revision = {
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

/** Workspace-scoped API call against the control plane (service binding). */
export function api(env: Env, token: string, path: string, init?: RequestInit) {
  return env.API_SERVICE.fetch(`https://api/api/v1/workspaces${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
}

/** List an environment's items, optionally narrowed to a single kind. */
export async function loadItems(
  env: Env,
  token: string,
  base: string,
  envId: string,
  kind?: ItemKind,
): Promise<ConfigRow[]> {
  const q = kind ? `?kind=${kind}` : ''
  const res = await api(env, token, `${base}/environments/${envId}/configs${q}`)
  if (res.status === 401) throw redirect('/login')
  return res.ok ? ((await res.json()) as { configs: ConfigRow[] }).configs : []
}

/** Recently deleted items (restorable), optionally narrowed to a kind. */
export async function loadDeleted(
  env: Env,
  token: string,
  base: string,
  envId: string,
  kind?: ItemKind,
): Promise<DeletedRow[]> {
  const res = await api(env, token, `${base}/environments/${envId}/deleted-configs`)
  const deleted = res.ok ? ((await res.json()) as { deleted: DeletedRow[] }).deleted : []
  return kind ? deleted.filter((d) => d.kind === kind) : deleted
}

/** Full revision history for one key (drives the inline History view). */
export async function loadRevisions(
  env: Env,
  token: string,
  base: string,
  envId: string,
  historyKey: string,
): Promise<Revision[]> {
  const res = await api(
    env,
    token,
    `${base}/environments/${envId}/configs/${encodeURIComponent(historyKey)}/revisions`,
  )
  return res.ok ? ((await res.json()) as { revisions: Revision[] }).revisions : []
}

/** Active (non-revoked) API keys scoped to this environment. */
export async function loadApiKeys(
  env: Env,
  token: string,
  base: string,
  envId: string,
): Promise<ApiKeyRow[]> {
  const res = await api(env, token, `${base}/api-keys`)
  return res.ok
    ? ((await res.json()) as { keys: ApiKeyRow[] }).keys.filter(
        (k) => k.environmentId === envId && !k.revokedAt,
      )
    : []
}

/**
 * The standard loader payload for a type section: the kind's items, its recently
 * deleted entries, and (when `?history=<key>` is present) that key's revisions.
 */
export async function loadSection(args: {
  request: Request
  env: Env
  workspaceId: string
  envId: string
  kind: ItemKind
}) {
  const { request, env, workspaceId, envId, kind } = args
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const base = `/${workspaceId}`
  const historyKey = new URL(request.url).searchParams.get('history')
  const [configs, deletedConfigs, revisions] = await Promise.all([
    loadItems(env, token, base, envId, kind),
    loadDeleted(env, token, base, envId, kind),
    historyKey ? loadRevisions(env, token, base, envId, historyKey) : Promise.resolve(null),
  ])
  return { workspaceId, envId, configs, deletedConfigs, historyKey, revisions }
}

/**
 * Every write the item sections can issue, dispatched by `intent`. Shared so all
 * four type sections (and the keys section) post to identical, audited handlers
 * regardless of which list the user is looking at.
 */
export async function handleItemAction(
  request: Request,
  env: Env,
  workspaceId: string,
  envId: string,
) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const base = `/${workspaceId}`
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'save') {
    const res = await api(env, token, `${base}/environments/${envId}/configs`, {
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
      `${base}/environments/${envId}/configs/${encodeURIComponent(key)}`,
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
    const res = await api(env, token, `${base}/environments/${envId}/api-keys`, {
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
        `${base}/environments/${envId}/configs/${encodeURIComponent(key)}`,
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
      `${base}/environments/${envId}/configs/${encodeURIComponent(key)}/restore`,
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
      `${base}/environments/${envId}/configs/${encodeURIComponent(key)}/reveal`,
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
