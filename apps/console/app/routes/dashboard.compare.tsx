import {
  Button,
  CardTable,
  Checkbox,
  Chip,
  type ChipVariant,
  cn,
  ErrorNote,
  Field,
  Select,
  StatusNote,
  Td,
  Th,
  TwoStepConfirm,
} from '@edgevault/ui'
import { useState } from 'react'
import { Form, redirect, useNavigation, useSearchParams } from 'react-router'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import { getWorkspaceName } from '../lib/workspace.server'
import type { Route } from './+types/dashboard.compare'

/**
 * Side-by-side environment comparison. Picks two environments, shows per-key
 * drift (equal / drifted / only-in-one), and offers one-click promotion of a
 * drifted or missing key into the target environment. Secrets compare by
 * presence only — the api never decrypts values for comparison.
 */

type EnvironmentSummary = { id: string; name: string; slug: string }

type DiffResult = { type: string; path: string; oldValue?: unknown; newValue?: unknown }

type ComparisonEntry = {
  key: string
  status: 'equal' | 'drifted' | 'only-in-source' | 'only-in-target' | 'not-comparable'
  source?: { kind: string; version: number; updatedAt: number }
  target?: { kind: string; version: number; updatedAt: number }
  diff?: DiffResult[]
  diffSummary?: string
}

type Comparison = {
  sourceEnvironmentId: string
  targetEnvironmentId: string
  entries: ComparisonEntry[]
  summary: {
    equal: number
    drifted: number
    onlyInSource: number
    onlyInTarget: number
    notComparable: number
  }
}

type MatrixCell = { version: number; content: string }
type MatrixItem = { key: string; kind: string; cells: Record<string, MatrixCell> }
type DriftMatrix = {
  environments: { id: string; name: string; slug: string }[]
  items: MatrixItem[]
}

const DRIFT_STATUS: Record<'sync' | 'drift' | 'pending', { label: string; chip: ChipVariant }> = {
  sync: { label: 'in sync', chip: 'drift-equal' },
  drift: { label: 'drifted', chip: 'drift-drifted' },
  pending: { label: 'pending', chip: 'drift-only' },
}

/** A row's drift status across all environments: present-everywhere-and-equal is
 * in sync, present-everywhere-but-different is drift, present-in-some is pending.
 * Secrets can't be value-compared, so they're judged on presence alone. */
function driftStatus(item: MatrixItem, envIds: string[]): 'sync' | 'drift' | 'pending' {
  const cells = envIds.map((id) => item.cells[id]).filter((c): c is MatrixCell => Boolean(c))
  if (cells.length < envIds.length) return 'pending'
  if (item.kind === 'secret') return 'sync'
  const first = cells[0]?.content
  return cells.every((c) => c.content === first) ? 'sync' : 'drift'
}

/** A single-line value preview for a matrix cell. */
function cellPreview(content: string): string {
  const s = content.replace(/\s+/g, ' ').trim()
  return s.length > 28 ? `${s.slice(0, 27)}…` : s
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Compare environments · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }

  const [envRes, matrixRes, workspaceName] = await Promise.all([
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    env.API_SERVICE.fetch(`${base}/environments/matrix`, { headers }),
    getWorkspaceName(env, token, params.workspaceId),
  ])
  if (envRes.status === 401 || envRes.status === 403) throw redirect('/login')
  const environments = envRes.ok
    ? ((await envRes.json()) as { environments: EnvironmentSummary[] }).environments
    : []
  const matrix: DriftMatrix = matrixRes.ok
    ? ((await matrixRes.json()) as DriftMatrix)
    : { environments: [], items: [] }

  const url = new URL(request.url)
  const source = url.searchParams.get('source')
  const target = url.searchParams.get('target')

  let comparison: Comparison | null = null
  let compareError: string | null = null
  if (source && target) {
    if (source === target) {
      compareError = 'Pick two different environments to compare.'
    } else {
      const res = await env.API_SERVICE.fetch(
        `${base}/environments/compare?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
        { headers },
      )
      if (res.ok) comparison = ((await res.json()) as { comparison: Comparison }).comparison
      else compareError = res.status === 404 ? 'Unknown environment.' : 'Comparison failed.'
    }
  }

  return {
    workspaceId: params.workspaceId,
    workspaceName,
    environments,
    comparison,
    compareError,
    matrix,
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const form = await request.formData()

  if (String(form.get('intent')) === 'bulk-promote') {
    const sourceEnvironmentId = String(form.get('sourceEnvironmentId') ?? '')
    const targetEnvironmentId = String(form.get('targetEnvironmentId') ?? '')
    const keys = String(form.get('keys') ?? '')
      .split('\n')
      .filter(Boolean)
    let started = 0
    const failures: string[] = []
    for (const key of keys) {
      const res = await context.cloudflare.env.API_SERVICE.fetch(
        `https://api/api/v1/workspaces/${params.workspaceId}/promotion-workflows`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sourceEnvironmentId, targetEnvironmentId, key }),
        },
      )
      if (res.ok) started += 1
      else failures.push(`"${key}"`)
    }
    return { bulkStarted: { count: started, failures } }
  }

  const body = {
    sourceEnvironmentId: String(form.get('sourceEnvironmentId') ?? ''),
    targetEnvironmentId: String(form.get('targetEnvironmentId') ?? ''),
    key: String(form.get('key') ?? ''),
  }
  // Through the durable workflow, not the direct endpoint: every promotion is
  // risk-scanned, and risky targets park at the approval gate instead of
  // applying silently.
  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/promotion-workflows`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) return { error: friendlyError(res.status, 'starting the promotion') }
  return { started: body.key }
}

const STATUS_LABEL: Record<ComparisonEntry['status'], string> = {
  equal: 'equal',
  drifted: 'drifted',
  'only-in-source': 'missing in target',
  'only-in-target': 'only in target',
  'not-comparable': 'secret (not compared)',
}

const DRIFT_CHIP: Record<ComparisonEntry['status'], ChipVariant> = {
  equal: 'drift-equal',
  drifted: 'drift-drifted',
  'only-in-source': 'drift-only',
  'only-in-target': 'drift-only',
  'not-comparable': 'drift-not-comparable',
}

/** One-sided secrets fall through the DO's not-comparable branch (it only fires
 * when the key exists in both environments) — label them honestly here. */
function entryLabel(entry: ComparisonEntry): string {
  const kind = (entry.source ?? entry.target)?.kind
  if (kind === 'secret' && entry.status !== 'not-comparable') {
    return `secret · ${STATUS_LABEL[entry.status]}`
  }
  return STATUS_LABEL[entry.status]
}

export default function CompareEnvironments({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, workspaceName, environments, comparison, compareError, matrix } = loaderData
  const [searchParams] = useSearchParams()
  const [onlyDrift, setOnlyDrift] = useState(false)
  const navigation = useNavigation()
  const source = searchParams.get('source') ?? ''
  const target = searchParams.get('target') ?? ''
  const envName = (id: string) => environments.find((e) => e.id === id)?.slug ?? id
  const bulkStarted =
    actionData && 'bulkStarted' in actionData ? (actionData.bulkStarted ?? null) : null
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const matrixEnvIds = matrix.environments.map((e) => e.id)
  const matrixRows = matrix.items.map((it) => ({ it, status: driftStatus(it, matrixEnvIds) }))
  const driftCounts = {
    sync: matrixRows.filter((r) => r.status === 'sync').length,
    drift: matrixRows.filter((r) => r.status === 'drift').length,
    pending: matrixRows.filter((r) => r.status === 'pending').length,
  }
  const visibleRows = onlyDrift ? matrixRows.filter((r) => r.status !== 'sync') : matrixRows

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Compare environments</p>
          <h1>{workspaceName ?? workspaceId}</h1>
        </div>
      </header>

      {matrix.items.length > 0 && matrix.environments.length > 0 && (
        <section className="mt-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2>Drift across environments</h2>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={() => setOnlyDrift((v) => !v)}
            >
              {onlyDrift ? 'Show all' : 'Only show drift'}
            </Button>
          </div>
          <p className="mb-3 text-sm tabular-nums text-muted-foreground">
            {matrix.items.length} keys · {driftCounts.sync} in sync · {driftCounts.drift} drifted ·{' '}
            {driftCounts.pending} pending
          </p>
          <CardTable label="Drift matrix">
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>Status</Th>
                {matrix.environments.map((e) => (
                  <Th key={e.id}>{e.name}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ it, status }) => {
                const baseline =
                  matrixEnvIds.map((id) => it.cells[id]).find((c): c is MatrixCell => Boolean(c))
                    ?.content ?? null
                return (
                  <tr key={it.key}>
                    <Td className="font-mono text-sm">{it.key}</Td>
                    <Td label="Status">
                      <Chip variant={DRIFT_STATUS[status].chip}>{DRIFT_STATUS[status].label}</Chip>
                    </Td>
                    {matrix.environments.map((e) => {
                      const cell = it.cells[e.id]
                      if (!cell) {
                        return (
                          <Td key={e.id} label={e.name} className="italic text-muted-foreground">
                            not set
                          </Td>
                        )
                      }
                      const differs = it.kind !== 'secret' && cell.content !== baseline
                      return (
                        <Td
                          key={e.id}
                          label={e.name}
                          className={cn('font-mono text-xs', differs && 'text-warn')}
                        >
                          {it.kind === 'secret'
                            ? `set · v${cell.version}`
                            : cellPreview(cell.content)}
                        </Td>
                      )
                    })}
                  </tr>
                )
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <Td colSpan={matrix.environments.length + 2} className="text-muted-foreground">
                    No drift — every key matches across environments.
                  </Td>
                </tr>
              )}
            </tbody>
          </CardTable>
        </section>
      )}

      <h2 className="mt-8">Compare two environments</h2>
      <Form method="get" className="my-5 flex flex-wrap items-end gap-3">
        <Field label="Source">
          <Select name="source" defaultValue={source}>
            <option value="">Choose…</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} /{e.slug}
              </option>
            ))}
          </Select>
        </Field>
        <span className="pb-2.5 text-muted-foreground">→</span>
        <Field label="Target">
          <Select name="target" defaultValue={target}>
            <option value="">Choose…</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} /{e.slug}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit">Compare</Button>
      </Form>

      {compareError && <ErrorNote>{compareError}</ErrorNote>}
      {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
      {bulkStarted && (
        <StatusNote>
          Started {bulkStarted.count} promotion
          {bulkStarted.count === 1 ? '' : 's'} — each runs the risk scan; risky targets park for
          approval on the dashboard.
          {bulkStarted.failures.length > 0 && ` Not started: ${bulkStarted.failures.join(', ')}.`}
        </StatusNote>
      )}
      {actionData && 'started' in actionData && (
        <StatusNote>
          Promotion of "{actionData.started}" started — it applies in seconds, or parks for approval
          if the risk scan flags it. Track it on the workspace dashboard.
        </StatusNote>
      )}

      {comparison && (
        <>
          <p className="mb-3 text-sm tabular-nums text-muted-foreground">
            {comparison.summary.equal} equal · {comparison.summary.drifted} drifted ·{' '}
            {comparison.summary.onlyInSource} missing in target · {comparison.summary.onlyInTarget}{' '}
            only in target · {comparison.summary.notComparable} secrets not compared
          </p>
          {selected.size > 0 && (
            <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <TwoStepConfirm
                trigger={`Promote ${selected.size} → /${envName(comparison.targetEnvironmentId)}`}
                disabled={navigation.state !== 'idle'}
                note={`Promote ${selected.size} key${selected.size === 1 ? '' : 's'} to /${envName(comparison.targetEnvironmentId)}? Each runs the risk scan first.`}
              >
                {(close) => (
                  <Form
                    method="post"
                    onSubmit={() => {
                      close()
                      setSelected(new Set())
                    }}
                  >
                    <input type="hidden" name="intent" value="bulk-promote" />
                    <input type="hidden" name="keys" value={[...selected].join('\n')} />
                    <input
                      type="hidden"
                      name="sourceEnvironmentId"
                      value={comparison.sourceEnvironmentId}
                    />
                    <input
                      type="hidden"
                      name="targetEnvironmentId"
                      value={comparison.targetEnvironmentId}
                    />
                    <Button
                      type="submit"
                      variant="danger"
                      size="compact"
                      loading={navigation.state !== 'idle'}
                    >
                      Confirm {selected.size} → /{envName(comparison.targetEnvironmentId)}
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
          <CardTable label="Comparison">
            <thead>
              <tr>
                <Th aria-label="Select" />
                <Th>Key</Th>
                <Th>Status</Th>
                <Th>{envName(comparison.sourceEnvironmentId)}</Th>
                <Th>{envName(comparison.targetEnvironmentId)}</Th>
                <Th>Changes</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {comparison.entries.map((entry) => (
                <tr key={entry.key}>
                  <Td>
                    {(entry.status === 'drifted' || entry.status === 'only-in-source') && (
                      <Checkbox
                        checked={selected.has(entry.key)}
                        onChange={() => toggle(entry.key)}
                        aria-label={`Select ${entry.key}`}
                      />
                    )}
                  </Td>
                  <Td className="font-mono text-sm">{entry.key}</Td>
                  <Td label="Status">
                    <Chip
                      variant={
                        (entry.source ?? entry.target)?.kind === 'secret'
                          ? 'drift-not-comparable'
                          : DRIFT_CHIP[entry.status]
                      }
                    >
                      {entryLabel(entry)}
                    </Chip>
                  </Td>
                  <Td
                    className="text-muted-foreground"
                    label={`/${envName(comparison.sourceEnvironmentId)}`}
                  >
                    {entry.source ? `v${entry.source.version}` : '—'}
                  </Td>
                  <Td
                    className="text-muted-foreground"
                    label={`/${envName(comparison.targetEnvironmentId)}`}
                  >
                    {entry.target ? `v${entry.target.version}` : '—'}
                  </Td>
                  <Td className="text-muted-foreground" label="Changes">
                    {entry.diff && entry.diff.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-accent">
                          {entry.diffSummary ?? `${entry.diff.length} changes`}
                        </summary>
                        <ul className="m-0 mt-1 list-none p-0 font-mono text-xs">
                          {entry.diff.map((d) => (
                            <li key={`${d.type}:${d.path}`}>
                              <span
                                className={
                                  d.type === 'added'
                                    ? 'text-ok'
                                    : d.type === 'removed'
                                      ? 'text-destructive'
                                      : 'text-warn'
                                }
                              >
                                {d.type}
                              </span>{' '}
                              {d.path}
                              {d.type !== 'added' && d.oldValue !== undefined && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  {JSON.stringify(d.oldValue)}
                                </span>
                              )}
                              {d.type !== 'removed' && d.newValue !== undefined && (
                                <span> → {JSON.stringify(d.newValue)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      (entry.diffSummary ?? '')
                    )}
                  </Td>
                  <Td>
                    {(entry.status === 'drifted' || entry.status === 'only-in-source') && (
                      <PromoteControl
                        entryKey={entry.key}
                        sourceEnvironmentId={comparison.sourceEnvironmentId}
                        targetEnvironmentId={comparison.targetEnvironmentId}
                        targetName={envName(comparison.targetEnvironmentId)}
                        isSecret={(entry.source ?? entry.target)?.kind === 'secret'}
                        busy={navigation.state !== 'idle'}
                      />
                    )}
                  </Td>
                </tr>
              ))}
              {comparison.entries.length === 0 && (
                <tr>
                  <Td colSpan={7} className="text-muted-foreground">
                    Both environments are empty.
                  </Td>
                </tr>
              )}
            </tbody>
          </CardTable>
        </>
      )}
    </section>
  )
}

/** Promotion mutates another environment's config — a two-step inline confirm,
 * never a single click. The confirm wears the danger voice (the safe exit stays
 * brand-colored); secrets say plainly that the sealed value is copied unseen. */
function PromoteControl({
  entryKey,
  sourceEnvironmentId,
  targetEnvironmentId,
  targetName,
  isSecret,
  busy,
}: {
  entryKey: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  targetName: string
  isSecret: boolean
  busy: boolean
}) {
  return (
    <TwoStepConfirm
      trigger={isSecret ? 'Promote secret →' : 'Promote →'}
      disabled={busy}
      note={
        isSecret
          ? `Copy this secret's sealed value to /${targetName}? The value is never displayed.`
          : `Overwrites /${targetName}; there is no undo.`
      }
    >
      {(close) => (
        <Form method="post" onSubmit={close}>
          <input type="hidden" name="key" value={entryKey} />
          <input type="hidden" name="sourceEnvironmentId" value={sourceEnvironmentId} />
          <input type="hidden" name="targetEnvironmentId" value={targetEnvironmentId} />
          <Button type="submit" variant="danger" size="compact" loading={busy}>
            Confirm → /{targetName}
          </Button>
        </Form>
      )}
    </TwoStepConfirm>
  )
}
