import {
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  EmptyRow,
  Field,
  Input,
  Select,
  Td,
  Th,
} from '@edgevault/ui'
import { Form, Link, useNavigation } from 'react-router'
import { humanizeAction } from '../lib/format'
import { LocalTime } from './local-time'

/**
 * The audit warehouse table, shared by the workspace and org views.
 *
 * The two scopes answer different questions — one records configuration and
 * secret operations, the other membership, policy, and identity — but the
 * reading experience should be identical, and a reviewer who learns the
 * filters on one shouldn't have to relearn them on the other.
 */

export type AuditEventRow = {
  at: number
  environmentId?: string
  action: string
  resourceType: string
  key?: string
  userId: string
  actor: string | null
  count?: number
  /** secret.revealed only: was a fresh second factor proven for this reveal. */
  stepUp?: boolean
  /** Structured context — names and identifiers only, never values. */
  detail?: Record<string, string>
}

export type AuditFacets = {
  actions: string[]
  resourceTypes: string[]
  actors: Array<{ userId: string; actor: string | null }>
}

export const AUDIT_FILTER_KEYS = ['from', 'to', 'env', 'action', 'resourceType', 'actor'] as const

export type AuditFilters = Record<(typeof AUDIT_FILTER_KEYS)[number], string>

/** Read the filter set off a request URL — used by both scopes' loaders. */
export function readAuditFilters(url: URL): AuditFilters {
  return Object.fromEntries(
    AUDIT_FILTER_KEYS.map((k) => [k, url.searchParams.get(k) ?? '']),
  ) as AuditFilters
}

/** Anomaly alerts share the table with ordinary changes and should not read
 * like one. Everything else stays neutral — an audit row is a fact, and
 * colouring routine writes would drown the two rows that matter. */
export function actionChip(action: string): ChipVariant {
  if (action.startsWith('alert.')) return 'warn'
  if (action === 'auth.access_denied') return 'warn'
  if (action === 'member.removed' || action === 'org.security_changed') return 'kind-flag'
  if (action === 'secret.revealed' || action === 'audit.exported') return 'kind-secret'
  return 'neutral'
}

export function actorLabel(userId: string, actor: string | null): string {
  if (actor) return actor
  if (userId === 'machine') return 'machine'
  return userId ? userId.slice(0, 8) : '—'
}

/** `{ subject: u2, to: admin }` → `subject=u2 · to=admin`, in one mono line. */
function formatDetail(detail: Record<string, string>): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
}

export function AuditFilterForm({
  filters,
  facets,
  environments,
  presets,
  withParams,
}: {
  filters: AuditFilters
  facets: AuditFacets
  /** Omitted for the org scope, which has no environments. */
  environments?: Array<{ id: string; name: string; slug: string }>
  presets: Array<{ label: string; from: string; to: string }>
  withParams: (extra: Record<string, string>) => string
}) {
  const filtered = AUDIT_FILTER_KEYS.some((k) => filters[k])
  return (
    <Form method="get" className="my-5 flex flex-wrap items-end gap-3">
      <Field label="From">
        <Input type="date" name="from" defaultValue={filters.from} />
      </Field>
      <Field label="To">
        <Input type="date" name="to" defaultValue={filters.to} />
      </Field>
      {environments && (
        <Field label="Environment">
          <Select name="env" defaultValue={filters.env}>
            <option value="">All environments</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} /{e.slug}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Action">
        <Select name="action" defaultValue={filters.action}>
          <option value="">All actions</option>
          {facets.actions.map((a) => (
            <option key={a} value={a}>
              {humanizeAction(a)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Resource">
        <Select name="resourceType" defaultValue={filters.resourceType}>
          <option value="">All resources</option>
          {facets.resourceTypes.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Actor">
        <Select name="actor" defaultValue={filters.actor}>
          <option value="">Anyone</option>
          {facets.actors.map((a) => (
            <option key={a.userId} value={a.userId}>
              {actorLabel(a.userId, a.actor)}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit">Query</Button>
      <span className="flex flex-wrap gap-2 pb-1.5">
        {presets.map((preset) => (
          <Link
            key={preset.label}
            className="rounded-sm border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground no-underline transition-colors hover:border-accent hover:text-accent"
            to={withParams({ from: preset.from, to: preset.to })}
          >
            {preset.label}
          </Link>
        ))}
        {filtered && (
          <Link
            className="rounded-sm border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground no-underline transition-colors hover:border-accent hover:text-accent"
            to="?"
          >
            Clear filters
          </Link>
        )}
      </span>
    </Form>
  )
}

export function AuditTable({
  events,
  filtered,
  emptyHint,
  envSlug,
}: {
  events: AuditEventRow[]
  filtered: boolean
  emptyHint: string
  /** Workspace scope resolves an environment slug; org scope has none. */
  envSlug?: (id?: string) => string | null
}) {
  const navigation = useNavigation()
  const busy = navigation.state === 'loading'
  const columns = envSlug ? 6 : 5

  // Warehouse events carry no id, and the same (time, action, key) triple can
  // legitimately repeat, so keys are composed with an occurrence counter —
  // stable across re-renders of the same query, unlike a bare array index.
  const seen = new Map<string, number>()
  const rows = events.map((event) => {
    const base = `${event.at}-${event.action}-${event.key ?? ''}-${event.userId}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { event, rowKey: n === 0 ? base : `${base}#${n}` }
  })

  return (
    <CardTable label="Audit events" stickyHeader>
      <thead>
        <tr>
          <Th>At</Th>
          <Th>Action</Th>
          <Th>Resource</Th>
          <Th>{envSlug ? 'Key' : 'Detail'}</Th>
          {envSlug && <Th>Environment</Th>}
          <Th>By</Th>
        </tr>
      </thead>
      <tbody data-pending={busy || undefined}>
        {rows.map(({ event, rowKey }) => (
          <tr key={rowKey}>
            <Td label="At" className="whitespace-nowrap text-muted-foreground">
              <LocalTime epoch={event.at} />
            </Td>
            <Td label="Action">
              <Chip variant={actionChip(event.action)}>{humanizeAction(event.action)}</Chip>
              {event.count && event.count > 1 && (
                <span className="text-muted-foreground"> ×{event.count}</span>
              )}
              {/* Whether a reveal cleared step-up is the single most
                  asked-about detail in this table; it rides the row. */}
              {event.action === 'secret.revealed' && (
                <span className="ml-2 font-mono text-xs text-muted-foreground-subtle">
                  {event.stepUp ? 'step-up' : 'no step-up'}
                </span>
              )}
            </Td>
            <Td label="Resource" className="font-mono text-xs text-muted-foreground">
              {event.resourceType}
            </Td>
            <Td label={envSlug ? 'Key' : 'Detail'} className="font-mono text-xs">
              {envSlug
                ? (event.key ?? '—')
                : event.detail
                  ? formatDetail(event.detail)
                  : (event.key ?? '—')}
            </Td>
            {envSlug && (
              <Td label="Environment" className="font-mono text-sm text-muted-foreground">
                {envSlug(event.environmentId) ? `/${envSlug(event.environmentId)}` : '—'}
              </Td>
            )}
            <Td label="By" className="text-muted-foreground">
              {actorLabel(event.userId, event.actor)}
            </Td>
          </tr>
        ))}
        {events.length === 0 && (
          <EmptyRow
            colSpan={columns}
            title={filtered ? 'No events match these filters' : 'No events in this range'}
            action={
              filtered ? (
                <Button variant="secondary" size="compact" asChild>
                  <Link to="?">Clear filters</Link>
                </Button>
              ) : undefined
            }
          >
            {filtered
              ? 'Widen the dates or clear a filter. Facets list only what has actually been recorded here, so an empty result means it never happened.'
              : emptyHint}
          </EmptyRow>
        )}
      </tbody>
    </CardTable>
  )
}
