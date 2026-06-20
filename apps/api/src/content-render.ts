import {
  type BlockNode,
  blockResolverFromMap,
  parseDocument,
  RenderError,
  renderDocument,
} from '@edgevault/blocks'
import { pageCacheKey } from '@edgevault/edge-protocol'
import type { ConfigItem, PublishTarget } from './durable-objects/types'
import type { VaultDurableObject } from './durable-objects/vault'
import { publishTargets } from './edge-cache'

type VaultStub = DurableObjectStub<VaultDurableObject>

/** Named page shells. The default (no/unknown layout) is passthrough — the
 *  document renders to a fragment, which is the right default for embedding. */
const PAGE_LAYOUTS: Record<string, (inner: string) => string> = {
  page: (inner) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body>${inner}</body></html>`,
}

/**
 * Progressive enhancement on the rendered HTML (the felix idea): external links
 * open safely, images lazy-load. Runs in the api worker's runtime via the global
 * HTMLRewriter — no DOM, streaming.
 */
function postProcessHtml(html: string): Promise<string> {
  const rewritten = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href')
        if (href && /^https?:/i.test(href)) {
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noopener noreferrer')
        }
      },
    })
    .on('img', {
      element(el) {
        if (!el.getAttribute('loading')) el.setAttribute('loading', 'lazy')
      },
    })
    .transform(new Response(html))
  return rewritten.text()
}

/**
 * Render one `content` document to its final HTML and write it to KV under the
 * `html:` key. No-op (with a warning) if the item is a block rather than a
 * document, or if rendering fails — the config-style write already succeeded, so
 * a render error must not take the whole publish down.
 */
async function renderAndStore(
  env: Env,
  stub: VaultStub,
  workspaceId: string,
  item: ConfigItem,
): Promise<void> {
  // A block ({type,props}) has no `blocks` array, so parseDocument rejects it —
  // that's the document-vs-block discriminator, no extra flag needed.
  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(item.content)
  } catch {
    return
  }

  const { content, blocks } = await stub.collectDocumentBlocks(item.environmentId, item.key)
  if (content === null) return

  const nodes: Record<string, BlockNode> = {}
  for (const [ref, raw] of Object.entries(blocks)) {
    try {
      nodes[ref] = JSON.parse(raw) as BlockNode
    } catch {
      // Leave unresolved — renderDocument throws a clear unresolved/invalid error.
    }
  }

  let html: string
  try {
    html = renderDocument(doc, {
      resolveBlock: blockResolverFromMap(nodes),
      layouts: PAGE_LAYOUTS,
    })
  } catch (error) {
    if (error instanceof RenderError) {
      console.warn(
        `content render skipped for ${workspaceId}/${item.environmentId}/${item.key}: ${error.code} ${error.message}`,
      )
      return
    }
    throw error
  }

  const finalHtml = await postProcessHtml(html)
  await env.CONFIGS_CACHE.put(pageCacheKey(workspaceId, item.environmentId, item.key), finalHtml)
}

/**
 * Publish a set of resolved targets to KV, then render every `content` document
 * among them to HTML. Used by every write fan-out (save/restore/revert/promote)
 * so editing a shared block re-renders each document that references it.
 */
export async function publishWithRender(
  env: Env,
  stub: VaultStub,
  workspaceId: string,
  targets: PublishTarget[],
): Promise<void> {
  await publishTargets(env, workspaceId, targets)
  await Promise.all(
    targets
      .filter((t) => t.item.kind === 'content')
      .map((t) => renderAndStore(env, stub, workspaceId, t.item)),
  )
}

/** Remove a content document's rendered HTML from the edge cache. */
export function deletePageThrough(
  env: Env,
  workspaceId: string,
  environmentId: string,
  key: string,
): Promise<void> {
  return env.CONFIGS_CACHE.delete(pageCacheKey(workspaceId, environmentId, key))
}
