import {
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  ErrorNote,
  Field,
  Select,
  StatusNote,
  Td,
  Th,
  TwoStepConfirm,
} from '@edgevault/ui'
import { Form, Link, redirect, useNavigation, useSearchParams } from 'react-router'
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

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Compare environments · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const env = context.cloudflare.env
  const base = `https://api/api/v1/workspaces/${params.workspaceId}`
  const headers = { authorization: `Bearer ${token}` }

  const [envRes, workspaceName] = await Promise.all([
    env.API_SERVICE.fetch(`${base}/environments`, { headers }),
    getWorkspaceName(env, token, params.workspaceId),
  ])
  if (envRes.status === 401 || envRes.status === 403) throw redirect('/login')
  const environments = envRes.ok
    ? ((await envRes.json()) as { environments: EnvironmentSummary[] }).environments
    : []

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

  return { workspaceId: params.workspaceId, workspaceName, environments, comparison, compareError }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')

  const form = await request.formData()
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
  const { workspaceId, workspaceName, environments, comparison, compareError } = loaderData
  const [searchParams] = useSearchParams()
  const navigation = useNavigation()
  const source = searchParams.get('source') ?? ''
  const target = searchParams.get('target') ?? ''
  const envName = (id: string) => environments.find((e) => e.id === id)?.slug ?? id

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Compare environments</p>
            <h1>{workspaceName ?? workspaceId}</h1>
          </div>
          <Button variant="secondary" asChild>
            <Link to={`/dashboard/${workspaceId}`}>← Workspace</Link>
          </Button>
        </header>

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
        {actionData && 'started' in actionData && (
          <StatusNote>
            Promotion of "{actionData.started}" started — it applies in seconds, or parks for
            approval if the risk scan flags it. Track it on the workspace dashboard.
          </StatusNote>
        )}

        {comparison && (
          <>
            <p className="mb-3 text-sm tabular-nums text-muted-foreground">
              {comparison.summary.equal} equal · {comparison.summary.drifted} drifted ·{' '}
              {comparison.summary.onlyInSource} missing in target ·{' '}
              {comparison.summary.onlyInTarget} only in target · {comparison.summary.notComparable}{' '}
              secrets not compared
            </p>
            <CardTable label="Comparison">
              <thead>
                <tr>
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
                      {entry.diffSummary ?? ''}
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
                    <Td colSpan={6} className="text-muted-foreground">
                      Both environments are empty.
                    </Td>
                  </tr>
                )}
              </tbody>
            </CardTable>
          </>
        )}
      </section>
    </main>
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
          <Button type="submit" variant="danger" size="compact" disabled={busy}>
            Confirm → /{targetName}
          </Button>
        </Form>
      )}
    </TwoStepConfirm>
  )
}
