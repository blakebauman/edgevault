import {
  ActionGroup,
  Button,
  CardTable,
  Checkbox,
  Chip,
  cn,
  ErrorNote,
  Field,
  Input,
  Select,
  StatusNote,
  Td,
  Textarea,
  Th,
  TwoStepConfirm,
} from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'
import { Form, Link, useFetcher, useNavigation, useSearchParams } from 'react-router'
import type { AcrossEnvRow, ConfigRow, DeletedRow, ItemKind, Revision } from '../lib/items.server'
import { HeaderActions } from './header-actions'
import { LocalTime } from './local-time'
import { RevealField } from './reveal-field'
import { StepUpPrompt } from './step-up-prompt'

/**
 * Reusable UI for the per-type item sections. Each section (Config / Flags /
 * Secrets / Content) pins its `kind` and composes these pieces, so the list, the
 * add/edit form, history, reveal, and the standard status notes are written once
 * and behave identically wherever they appear.
 */

const CONTENT_TYPES = ['json', 'yaml', 'xml', 'ini', 'toml', 'properties', 'csv', 'text'] as const

const KIND_HINT: Record<ItemKind, string> = {
  config: 'Plain configuration — served from the edge, indexed for search.',
  flag: 'Feature flag — booleans, percentages, or JSON; SDK flag() reads these.',
  secret: 'Envelope-encrypted before storage. The value is shown only via an audited reveal.',
  content:
    'Structured content — a document of blocks (or a reusable block) rendered to HTML at the edge.',
}

/** Human label per kind for headings, hints, and empty states. */
export const KIND_NOUN: Record<ItemKind, { one: string; add: string }> = {
  config: { one: 'config', add: 'config' },
  flag: { one: 'flag', add: 'flag' },
  secret: { one: 'secret', add: 'secret' },
  content: { one: 'content item', add: 'block or page' },
}

const ITEM_KINDS: readonly ItemKind[] = ['config', 'flag', 'secret', 'content']
const toKind = (s: string): ItemKind =>
  ITEM_KINDS.includes(s as ItemKind) ? (s as ItemKind) : 'config'

/**
 * A real, valid starting value per kind — the form pre-fills it so a fresh item
 * teaches the shape instead of facing a blank box. Format tracks kind: flags and
 * content are JSON documents, secrets are opaque text, only config is free-format.
 */
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

// ---------------------------------------------------------------------------
// Selection (bulk delete)
// ---------------------------------------------------------------------------

export function useItemSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleAll = (keys: string[]) =>
    setSelected((prev) => (prev.size === keys.length ? new Set() : new Set(keys)))
  const clear = () => setSelected(new Set())
  return { selected, toggle, toggleAll, clear }
}

// ---------------------------------------------------------------------------
// Reveal (audited secret reveal over a fetcher)
// ---------------------------------------------------------------------------

type RevealData = { revealed?: { key: string; content: string }; revealError?: string }

/**
 * Drives an audited secret reveal over a fetcher (POST, no navigation) so the
 * plaintext never touches the URL, history, or SSR document. The value is
 * mirrored into owned state we fully control: it auto-clears after a TTL and on
 * unmount (navigate), and a per-data-object guard stops the fetcher's lingering
 * result from re-populating after we've dropped it.
 */
export function useReveal() {
  const fetcher = useFetcher<RevealData>()
  const [revealed, setRevealed] = useState<{ key: string; content: string } | null>(null)
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
    if (data.revealed) {
      setRevealed(data.revealed)
      setNeedsStepUp(null)
    } else if (data.revealError === 'reauth_required') {
      setNeedsStepUp(lastKey.current)
    }
  }, [fetcher.data])

  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => setRevealed(null), REVEAL_TTL_MS)
    return () => clearTimeout(t)
  }, [revealed])

  const rawError = fetcher.data?.revealError ?? null
  const error = revealed || needsStepUp || rawError === 'reauth_required' ? null : rawError

  return {
    revealed,
    needsStepUp,
    error,
    pending: fetcher.state !== 'idle',
    pendingKey: lastKey.current,
    reveal: submit,
    retryStepUp: () => needsStepUp && submit(needsStepUp),
    cancelStepUp: () => setNeedsStepUp(null),
    clear: () => setRevealed(null),
  }
}

type Reveal = ReturnType<typeof useReveal>

/** Step-up prompt + revealed plaintext, rendered above a secrets list. */
export function RevealRegion({ reveal, workspaceId }: { reveal: Reveal; workspaceId: string }) {
  return (
    <>
      {reveal.error && <ErrorNote>{reveal.error}</ErrorNote>}
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
    </>
  )
}

// ---------------------------------------------------------------------------
// Status notes shared across every item write
// ---------------------------------------------------------------------------

type ActionData = Record<string, unknown> | null | undefined

/** The standard status/error notes for the item CRUD intents. */
export function ItemActionNotes({ actionData, busy }: { actionData: ActionData; busy: boolean }) {
  const d = actionData ?? {}
  const error = 'error' in d ? (d.error as string) : null
  const saved = 'saved' in d ? (d.saved as { key: string; version: number }) : null
  const deleted = 'deleted' in d ? (d.deleted as string) : null
  const restored = 'restored' in d ? (d.restored as { key: string; version: number }) : null
  const bulkDeleted =
    'bulkDeleted' in d ? (d.bulkDeleted as { count: number; failures: string[] }) : null
  const reverted = 'reverted' in d ? (d.reverted as boolean) : false

  return (
    <>
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
          Recently deleted.
        </StatusNote>
      )}
      {bulkDeleted && bulkDeleted.failures.length > 0 && (
        <ErrorNote>Not deleted: {bulkDeleted.failures.join('; ')}.</ErrorNote>
      )}
      {reverted && <StatusNote>Reverted — a new revision now carries the old content.</StatusNote>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Items table
// ---------------------------------------------------------------------------

export function ItemsTable({
  configs,
  selected,
  onToggle,
  onToggleAll,
  busy,
  revealPendingKey,
  baseSearch,
  pageHref,
  onEdit,
  onReveal,
  empty,
  selectedKey,
  onSelect,
}: {
  configs: ConfigRow[]
  selected: ReadonlySet<string>
  onToggle: (key: string) => void
  onToggleAll: (keys: string[]) => void
  busy: boolean
  revealPendingKey?: string | null
  baseSearch: (extra: Record<string, string>) => string
  pageHref: (key: string) => string
  onEdit: (item: ConfigRow) => void
  onReveal: (key: string) => void
  empty: React.ReactNode
  selectedKey?: string | null
  /** Row click opens the read-detail panel; interactive cells stop propagation. */
  onSelect?: (item: ConfigRow) => void
}) {
  const keys = configs.map((c) => c.key)
  return (
    <CardTable label="Items">
      <thead>
        <tr>
          <Th>
            <Checkbox
              checked={selected.size === configs.length && configs.length > 0}
              onChange={() => onToggleAll(keys)}
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
          <tr
            key={item.key}
            className={cn(
              onSelect && 'item-row-clickable',
              selectedKey === item.key && 'item-row-sel',
            )}
            onClick={onSelect ? () => onSelect(item) : undefined}
          >
            <Td onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={selected.has(item.key)}
                onChange={() => onToggle(item.key)}
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
            <Td onClick={(e) => e.stopPropagation()}>
              <ItemActions
                item={item}
                busy={busy}
                revealing={revealPendingKey === item.key}
                baseSearch={baseSearch}
                pageHref={pageHref(item.key)}
                onEdit={() => onEdit(item)}
                onReveal={() => onReveal(item.key)}
              />
            </Td>
          </tr>
        ))}
        {configs.length === 0 && (
          <tr>
            <Td colSpan={6} className="text-muted-foreground">
              {empty}
            </Td>
          </tr>
        )}
      </tbody>
    </CardTable>
  )
}

/** Bulk-delete affordance shown above the table when rows are selected. */
export function BulkDeleteBar({
  selected,
  busy,
  onCleared,
}: {
  selected: ReadonlySet<string>
  busy: boolean
  onCleared: () => void
}) {
  if (selected.size === 0) return null
  return (
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
              onCleared()
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
      <Button type="button" variant="linklike" size="compact" onClick={onCleared}>
        Clear
      </Button>
    </div>
  )
}

/** Recently-deleted list with restore + history links. */
export function RecentlyDeleted({
  deleted,
  busy,
  baseSearch,
}: {
  deleted: DeletedRow[]
  busy: boolean
  baseSearch: (extra: Record<string, string>) => string
}) {
  if (deleted.length === 0) return <p className="text-sm text-muted-foreground">Nothing deleted.</p>
  return (
    <ul className="feed mt-3" aria-label="Recently deleted keys">
      {deleted.map((d) => (
        <li key={d.key} className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm">{d.key}</span>
          {d.kind && <Chip variant={`kind-${d.kind as ItemKind}`}>{d.kind}</Chip>}
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
  )
}

/** Inline revision history with revert, opened via the `?history=` param. */
export function RevisionHistory({
  historyKey,
  revisions,
  busy,
  baseSearch,
}: {
  historyKey: string
  revisions: Revision[]
  busy: boolean
  baseSearch: (extra: Record<string, string>) => string
}) {
  return (
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
  )
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

export function ItemForm({
  editing,
  loading,
  successKey,
  allKeys,
  lockedKind,
  onDone,
  inPanel,
}: {
  editing: ConfigRow | null
  loading: boolean
  successKey?: string
  allKeys: string[]
  /** When set, the form pins this kind (no kind picker) — the section owns it. */
  lockedKind?: ItemKind
  onDone: () => void
  /** Rendered inside the detail panel — the wrapper supplies top spacing. */
  inPanel?: boolean
}) {
  const initialKind: ItemKind = editing?.kind ?? lockedKind ?? 'config'
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
  const showKindPicker = !lockedKind

  return (
    <Form
      method="post"
      className={cn('flex max-w-xl flex-col gap-3', !inPanel && 'mt-6')}
      onSubmit={validate}
    >
      <input type="hidden" name="intent" value="save" />
      {lockedKind && <input type="hidden" name="kind" value={kind} />}
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
        {showKindPicker && (
          <Field label="Kind">
            <Select name="kind" value={kind} onChange={(e) => changeKind(e.target.value)}>
              <option value="config">config</option>
              <option value="flag">flag</option>
              <option value="secret">secret</option>
              <option value="content">content</option>
            </Select>
          </Field>
        )}
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
      <p className="m-0 text-xs text-muted-foreground">{KIND_HINT[toKind(kind)]}</p>

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
export function FlagEditor({
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

/**
 * Read-only detail for the selected item, shown beside the list. The value is
 * inlined for config/flags; secrets stay masked — plaintext only ever arrives
 * through the audited Reveal, which surfaces in the section's RevealRegion.
 * Actions mirror the row's so either entry point works.
 */
/** A single-line value preview for the across-environments matrix. */
function preview(content: string): string {
  const s = content.replace(/\s+/g, ' ').trim()
  return s.length > 32 ? `${s.slice(0, 31)}…` : s
}

function ItemDetail({
  item,
  busy,
  revealing,
  baseSearch,
  pageHref,
  onEdit,
  onReveal,
  onClose,
  currentEnvId,
  matrix,
  matrixLoading,
}: {
  item: ConfigRow
  busy: boolean
  revealing: boolean
  baseSearch: (extra: Record<string, string>) => string
  pageHref: string
  onEdit: () => void
  onReveal: () => void
  onClose: () => void
  currentEnvId: string
  matrix: { key: string; environments: AcrossEnvRow[] } | null
  matrixLoading: boolean
}) {
  const isSecret = item.kind === 'secret'
  return (
    <aside className="item-detail" aria-label={`Details for ${item.key}`}>
      <div className="item-detail-head">
        <Chip variant={`kind-${item.kind}`}>{item.kind}</Chip>
        <span className="dk">{item.key}</span>
        <Button type="button" variant="linklike" size="compact" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="item-detail-body">
        <div className="item-detail-sec">
          <p className="item-detail-label">Value</p>
          {isSecret ? (
            <p className="item-detail-value masked">•••••••••••••••• — encrypted; use Reveal</p>
          ) : (
            <pre className="item-detail-value">{item.content}</pre>
          )}
        </div>
        <div className="item-detail-sec">
          <p className="item-detail-label">Across environments</p>
          {matrix && matrix.key === item.key ? (
            <div className="env-matrix">
              {matrix.environments.map((e) => {
                const present = Boolean(e.item)
                const isCur = e.id === currentEnvId
                const differs = present && !isSecret && e.item?.content !== item.content
                return (
                  <div key={e.id} className={cn('env-mrow', isCur && 'cur')}>
                    <span className="env-name">{e.name}</span>
                    <span className={cn('env-val', !present && 'unset', differs && 'drift')}>
                      {!present
                        ? 'not set'
                        : isSecret
                          ? `set · v${e.item?.version}`
                          : preview(e.item?.content ?? '')}
                    </span>
                    {isCur ? (
                      <span className="env-tag cur">current</span>
                    ) : differs ? (
                      <span className="env-tag drift">differs</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">{matrixLoading ? 'Loading…' : '—'}</p>
          )}
        </div>

        <div className="item-detail-sec item-detail-meta">
          <span>Version v{item.version}</span>
          <span>
            Updated <LocalTime epoch={item.updatedAt} />
          </span>
        </div>
      </div>
      <div className="item-detail-actions">
        {!isSecret && (
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
        {isSecret && (
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
        <TwoStepConfirm trigger="Delete" disabled={busy} note={`Delete "${item.key}"?`}>
          {(close) => (
            <Form method="post" onSubmit={close}>
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="key" value={item.key} />
              <Button type="submit" variant="danger" size="compact" disabled={busy}>
                Confirm delete
              </Button>
            </Form>
          )}
        </TwoStepConfirm>
      </div>
    </aside>
  )
}

/** Compact revision history for the detail panel — the wide table doesn't fit
 * the column, so revisions stack vertically; revert is unchanged. */
function ItemHistory({
  historyKey,
  revisions,
  busy,
  baseSearch,
}: {
  historyKey: string
  revisions: Revision[]
  busy: boolean
  baseSearch: (extra: Record<string, string>) => string
}) {
  return (
    <aside className="item-detail" aria-label={`History for ${historyKey}`}>
      <div className="item-detail-head">
        <Chip variant="neutral">history</Chip>
        <span className="dk">{historyKey}</span>
        <Button variant="linklike" size="compact" asChild>
          <Link to={baseSearch({})}>Close</Link>
        </Button>
      </div>
      <div className="item-detail-body">
        {revisions.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No revisions recorded.</p>
        ) : (
          <ol className="rev-list">
            {revisions.map((rev) => (
              <li key={rev.id} className="rev">
                <div className="rev-top">
                  <span className="rev-ver">v{rev.version}</span>
                  <Chip variant="neutral">{rev.changeType}</Chip>
                  <span className="rev-time">
                    <LocalTime epoch={rev.createdAt} />
                  </span>
                </div>
                <div className="rev-by">
                  {rev.actor ?? <span className="font-mono">{rev.createdBy.slice(0, 8)}</span>}
                  {rev.summary ? ` · ${rev.summary}` : ''}
                </div>
                <RevertControl revisionId={rev.id} version={rev.version} busy={busy} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
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

// ---------------------------------------------------------------------------
// Subtabs
// ---------------------------------------------------------------------------

export function Subtabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: React.ReactNode }>
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div className="subtabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The standard section: list + history + form, for config / flags / secrets
// ---------------------------------------------------------------------------

type SectionData = {
  workspaceId: string
  envId: string
  configs: ConfigRow[]
  deletedConfigs: DeletedRow[]
  historyKey: string | null
  revisions: Revision[] | null
}

/**
 * The full type-section body (list · recently deleted · history · add/edit form)
 * for the kinds that share the same shape — config, flags, secrets. The kind is
 * pinned, so the list shows only that kind and the form can't switch away.
 */
export function ItemSection({
  kind,
  loaderData,
  actionData,
  emptyHint,
}: {
  kind: ItemKind
  loaderData: SectionData
  actionData: ActionData
  emptyHint?: React.ReactNode
}) {
  const { workspaceId, envId, configs, deletedConfigs, historyKey, revisions } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const pendingIntent = navigation.formData?.get('intent')
  const reveal = useReveal()
  const matrixFetcher = useFetcher<{ key: string; environments: AcrossEnvRow[] }>()
  const [searchParams] = useSearchParams()
  const [editing, setEditing] = useState<ConfigRow | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState<'items' | 'deleted'>('items')
  const selection = useItemSelection()

  const saved =
    actionData && 'saved' in actionData
      ? (actionData.saved as { key: string; version: number })
      : null
  const savingItem = busy && pendingIntent === 'save'
  const savedKey = saved ? `${saved.key}@${saved.version}` : undefined
  const referenceableKeys = configs.filter((c) => c.kind !== 'secret').map((c) => c.key)
  const noun = KIND_NOUN[kind]
  const selectedItem = selectedKey ? (configs.find((c) => c.key === selectedKey) ?? null) : null

  // The detail panel hosts the read view, the edit form, or the create form.
  const startEdit = (item: ConfigRow) => {
    setEditing(item)
    setSelectedKey(item.key)
    setCreating(false)
  }
  const startCreate = () => {
    setCreating(true)
    setEditing(null)
    setSelectedKey(null)
  }
  const closeForm = () => {
    setEditing(null)
    setCreating(false)
  }

  // Load the across-environments matrix for the selected key, on demand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the selection changes
  useEffect(() => {
    if (selectedKey) {
      matrixFetcher.load(
        `/dashboard/${workspaceId}/configs/${encodeURIComponent(selectedKey)}/across`,
      )
    }
  }, [selectedKey, workspaceId])

  const baseSearch = (extra: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    next.delete('reveal')
    next.delete('history')
    for (const [k, v] of Object.entries(extra)) next.set(k, v)
    const qs = next.toString()
    return qs ? `?${qs}` : '.'
  }
  const pageHref = (key: string) =>
    `/dashboard/${workspaceId}/env/${envId}/pages/${encodeURIComponent(key)}`

  const defaultEmpty =
    emptyHint ??
    `No ${noun.one}s here yet. Add your first ${noun.add} with "New ${noun.add}" — it's live at the edge seconds after saving.`

  return (
    <>
      <ItemActionNotes actionData={actionData} busy={busy} />
      {kind === 'secret' && <RevealRegion reveal={reveal} workspaceId={workspaceId} />}

      <Subtabs
        tabs={[
          { id: 'items', label: 'Items' },
          { id: 'deleted', label: `Recently deleted (${deletedConfigs.length})` },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'items' | 'deleted')}
      />

      {tab === 'items' ? (
        <div className="item-split">
          <HeaderActions>
            <Button type="button" size="compact" onClick={startCreate}>
              New {noun.add}
            </Button>
          </HeaderActions>
          <div className="item-list-col">
            <BulkDeleteBar selected={selection.selected} busy={busy} onCleared={selection.clear} />
            <ItemsTable
              configs={configs}
              selected={selection.selected}
              onToggle={selection.toggle}
              onToggleAll={selection.toggleAll}
              busy={busy}
              revealPendingKey={reveal.pending ? reveal.pendingKey : null}
              baseSearch={baseSearch}
              pageHref={pageHref}
              onEdit={startEdit}
              onReveal={reveal.reveal}
              empty={defaultEmpty}
              selectedKey={selectedKey}
              onSelect={(item) => {
                setSelectedKey(item.key)
                closeForm()
              }}
            />
          </div>
          <div className="item-detail-col">
            {editing || creating ? (
              <div className="item-detail">
                <div className="item-detail-head">
                  <span className="dk">{editing ? `Edit ${editing.key}` : `New ${noun.add}`}</span>
                  <Button type="button" variant="linklike" size="compact" onClick={closeForm}>
                    Close
                  </Button>
                </div>
                <div className="item-detail-body">
                  <ItemForm
                    key={editing?.key ?? 'new'}
                    editing={editing}
                    loading={savingItem}
                    successKey={savedKey}
                    allKeys={referenceableKeys}
                    lockedKind={kind}
                    onDone={closeForm}
                    inPanel
                  />
                </div>
              </div>
            ) : historyKey && revisions ? (
              <ItemHistory
                historyKey={historyKey}
                revisions={revisions}
                busy={busy}
                baseSearch={baseSearch}
              />
            ) : selectedItem ? (
              <ItemDetail
                item={selectedItem}
                busy={busy}
                revealing={reveal.pending && reveal.pendingKey === selectedItem.key}
                baseSearch={baseSearch}
                pageHref={pageHref(selectedItem.key)}
                onEdit={() => startEdit(selectedItem)}
                onReveal={() => reveal.reveal(selectedItem.key)}
                onClose={() => setSelectedKey(null)}
                currentEnvId={envId}
                matrix={matrixFetcher.data ?? null}
                matrixLoading={matrixFetcher.state !== 'idle'}
              />
            ) : (
              <div className="item-detail-empty">
                Select a {noun.one} to see its value and actions, or add a {noun.add}.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <RecentlyDeleted deleted={deletedConfigs} busy={busy} baseSearch={baseSearch} />
          {historyKey && revisions && (
            <RevisionHistory
              historyKey={historyKey}
              revisions={revisions}
              busy={busy}
              baseSearch={baseSearch}
            />
          )}
        </>
      )}
    </>
  )
}

/** Expiry cell: plain date normally; a nudge once a key is 14 days from death. */
export function KeyExpiry({ expiresAt }: { expiresAt: string | null }) {
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
