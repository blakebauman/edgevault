import { useState } from 'react'
import { useNavigation, useSearchParams } from 'react-router'
import {
  BulkDeleteBar,
  ItemActionNotes,
  ItemForm,
  ItemsTable,
  RecentlyDeleted,
  RevisionHistory,
  Subtabs,
  useItemSelection,
} from '../components/items'
import type { ConfigRow } from '../lib/items.server'
import { handleItemAction, loadSection } from '../lib/items.server'
import type { Route } from './+types/environment.content'

/**
 * Content section: the `content` kind, split into Documents (an ordered list of
 * blocks, rendered to HTML at the edge) and reusable Blocks (referenced from
 * documents via ${block.key}). Documents open the live page editor; blocks edit
 * inline. The split is structural — a content item whose JSON has a `blocks`
 * array is a document, everything else is a reusable block.
 */

export function meta() {
  return [{ title: 'Content · EdgeVault' }]
}

export function loader({ request, params, context }: Route.LoaderArgs) {
  return loadSection({
    request,
    env: context.cloudflare.env,
    workspaceId: params.workspaceId,
    envId: params.envId,
    kind: 'content',
  })
}

export function action({ request, params, context }: Route.ActionArgs) {
  return handleItemAction(request, context.cloudflare.env, params.workspaceId, params.envId)
}

/** A content item is a document when its JSON carries a `blocks` array. */
function isDocument(item: ConfigRow): boolean {
  try {
    const parsed = JSON.parse(item.content) as { blocks?: unknown }
    return Array.isArray(parsed?.blocks)
  } catch {
    return false
  }
}

export default function ContentSection({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaceId, envId, configs, deletedConfigs, historyKey, revisions } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const pendingIntent = navigation.formData?.get('intent')
  const [searchParams] = useSearchParams()
  const [editing, setEditing] = useState<ConfigRow | null>(null)
  const [tab, setTab] = useState<'documents' | 'blocks' | 'deleted'>('documents')
  const selection = useItemSelection()

  const saved =
    actionData && 'saved' in actionData
      ? (actionData.saved as { key: string; version: number })
      : null
  const savingItem = busy && pendingIntent === 'save'
  const savedKey = saved ? `${saved.key}@${saved.version}` : undefined

  const documents = configs.filter(isDocument)
  const blocks = configs.filter((c) => !isDocument(c))
  const shown = tab === 'documents' ? documents : tab === 'blocks' ? blocks : []
  const referenceableKeys = configs.map((c) => c.key)

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

  return (
    <>
      <ItemActionNotes actionData={actionData} busy={busy} />

      <Subtabs
        tabs={[
          { id: 'documents', label: `Documents (${documents.length})` },
          { id: 'blocks', label: `Blocks (${blocks.length})` },
          { id: 'deleted', label: `Recently deleted (${deletedConfigs.length})` },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'documents' | 'blocks' | 'deleted')}
      />

      {tab === 'deleted' ? (
        <RecentlyDeleted deleted={deletedConfigs} busy={busy} baseSearch={baseSearch} />
      ) : (
        <>
          <BulkDeleteBar selected={selection.selected} busy={busy} onCleared={selection.clear} />
          <ItemsTable
            configs={shown}
            selected={selection.selected}
            onToggle={selection.toggle}
            onToggleAll={selection.toggleAll}
            busy={busy}
            baseSearch={baseSearch}
            pageHref={pageHref}
            onEdit={setEditing}
            onReveal={() => {}}
            empty={
              tab === 'documents'
                ? 'No pages yet. Add a document below — give it a `blocks` array — then open it in the page editor for a live preview.'
                : 'No reusable blocks yet. Add one below; reference it from a document with ${block.key}.'
            }
          />
        </>
      )}

      {historyKey && revisions && (
        <RevisionHistory
          historyKey={historyKey}
          revisions={revisions}
          busy={busy}
          baseSearch={baseSearch}
        />
      )}

      <h2>{editing ? `Edit "${editing.key}"` : 'Add a block or page'}</h2>
      <ItemForm
        key={editing?.key ?? 'new'}
        editing={editing}
        loading={savingItem}
        successKey={savedKey}
        allKeys={referenceableKeys}
        lockedKind="content"
        onDone={() => setEditing(null)}
      />
    </>
  )
}
