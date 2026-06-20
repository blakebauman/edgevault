/**
 * Structured-content block model: a CMS page is a `document` (an ordered list of
 * blocks) and each block is a typed, reusable unit. This package is the registry
 * (`type -> { schema, render }`) plus a pure `renderDocument` that turns a
 * document into HTML.
 *
 * It is deliberately pure: no DO, no fetch, no I/O. The caller supplies a
 * `resolveBlock` callback to turn a `${block.key}` reference into a block node
 * (the api worker resolves from the Vault DO; the console preview resolves from
 * its loaded set). The same registry runs in both places, so the publish-time
 * HTML and the live preview are byte-identical.
 *
 * Rendering fails loudly (throws `RenderError`) on an unknown type, invalid
 * props, or an unresolved reference — mirroring how reference validation throws
 * at write time, so broken content can never be published.
 */

import { z } from 'zod'

// --- HTML helpers -----------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for safe interpolation into HTML element/attribute content. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string)
}

/**
 * Make a user-supplied href safe to emit: strip dangerous schemes
 * (`javascript:`, `data:`, `vbscript:`) and escape the rest. http(s), mailto,
 * relative paths and anchors pass through.
 */
export function safeHref(href: string): string {
  const trimmed = href.trim()
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return '#'
  return escapeHtml(trimmed)
}

// --- Block model ------------------------------------------------------------

/** A concrete block instance: a registered `type` plus its raw props. */
export interface BlockNode {
  type: string
  props: Record<string, unknown>
}

/**
 * One entry in a document's block list: either an inline block or a
 * `${block.key}` reference resolved via `RenderOptions.resolveBlock`.
 */
export type BlockEntry = BlockNode | string

/** A page: an ordered list of blocks plus an optional named layout shell. */
export interface DocumentNode {
  layout?: string
  blocks: BlockEntry[]
}

/** A registered block type: a props schema and a pure validated-props renderer. */
export interface BlockDef<S extends z.ZodType = z.ZodType> {
  schema: S
  render: (props: z.infer<S>) => string
}

export type BlockRegistry = Record<string, BlockDef>

export type RenderErrorCode =
  | 'invalid-document'
  | 'unknown-type'
  | 'invalid-props'
  | 'unresolved-ref'

export class RenderError extends Error {
  readonly code: RenderErrorCode
  constructor(code: RenderErrorCode, message: string) {
    super(message)
    this.name = 'RenderError'
    this.code = code
  }
}

/** Helper to declare a block type with full prop-type inference. */
function defineBlock<S extends z.ZodType>(
  schema: S,
  render: (props: z.infer<S>) => string,
): BlockDef<S> {
  return { schema, render }
}

// --- Built-in block types ---------------------------------------------------

const hero = defineBlock(
  z.object({
    heading: z.string(),
    subheading: z.string().optional(),
    ctaLabel: z.string().optional(),
    ctaHref: z.string().optional(),
  }),
  (p) => {
    const sub = p.subheading ? `<p class="hero__sub">${escapeHtml(p.subheading)}</p>` : ''
    const cta =
      p.ctaLabel && p.ctaHref
        ? `<a class="hero__cta" href="${safeHref(p.ctaHref)}">${escapeHtml(p.ctaLabel)}</a>`
        : ''
    return `<section class="hero"><h1>${escapeHtml(p.heading)}</h1>${sub}${cta}</section>`
  },
)

const cta = defineBlock(
  z.object({
    label: z.string(),
    href: z.string(),
    variant: z.enum(['primary', 'secondary']).default('primary'),
  }),
  (p) => `<a class="cta cta--${p.variant}" href="${safeHref(p.href)}">${escapeHtml(p.label)}</a>`,
)

const richtext = defineBlock(
  // Trusted, pre-sanitized HTML from the authoring layer (sanitization is the
  // editor's responsibility, not the renderer's). A markdown variant can be
  // added later by injecting a renderer.
  z.object({ html: z.string() }),
  (p) => `<div class="richtext">${p.html}</div>`,
)

/** The default registry. Callers may pass their own via RenderOptions. */
export const blockRegistry: BlockRegistry = { hero, cta, richtext }

// --- Document parsing + rendering -------------------------------------------

const blockNodeSchema: z.ZodType<BlockNode> = z.object({
  type: z.string(),
  props: z.record(z.string(), z.unknown()),
})

const documentSchema: z.ZodType<DocumentNode> = z.object({
  layout: z.string().optional(),
  blocks: z.array(z.union([z.string(), blockNodeSchema])),
})

/** Parse + validate a document's JSON content. Throws RenderError on bad shape. */
export function parseDocument(json: string): DocumentNode {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    throw new RenderError('invalid-document', `document is not valid JSON: ${String(error)}`)
  }
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RenderError('invalid-document', `document shape invalid: ${parsed.error.message}`)
  }
  return parsed.data
}

export interface RenderOptions {
  /** Block type registry. Defaults to the built-in `blockRegistry`. */
  registry?: BlockRegistry
  /** Resolve a `${block.key}` entry to a block node. Required if the document
   *  contains string references. */
  resolveBlock?: (ref: string) => BlockNode | null
  /** Named layout shells. The document's `layout` (default `'default'`) selects
   *  one; an unknown name falls back to passthrough. */
  layouts?: Record<string, (inner: string, doc: DocumentNode) => string>
}

/** Render one block node to HTML, validating its props against the registry. */
export function renderBlock(node: BlockNode, registry: BlockRegistry = blockRegistry): string {
  const def = registry[node.type]
  if (!def) throw new RenderError('unknown-type', `unknown block type "${node.type}"`)
  const parsed = def.schema.safeParse(node.props)
  if (!parsed.success) {
    throw new RenderError('invalid-props', `block "${node.type}": ${parsed.error.message}`)
  }
  return def.render(parsed.data)
}

/** Render a document (block list + layout) to its final HTML string. */
export function renderDocument(doc: DocumentNode, options: RenderOptions = {}): string {
  const registry = options.registry ?? blockRegistry
  const parts: string[] = []
  for (const entry of doc.blocks) {
    let node: BlockNode
    if (typeof entry === 'string') {
      const resolved = options.resolveBlock?.(entry) ?? null
      if (!resolved) throw new RenderError('unresolved-ref', `cannot resolve block ${entry}`)
      node = resolved
    } else {
      node = entry
    }
    parts.push(renderBlock(node, registry))
  }
  const inner = parts.join('\n')
  const layout = options.layouts?.[doc.layout ?? 'default']
  return layout ? layout(inner, doc) : inner
}

/**
 * Build a `resolveBlock` from a key→node map, accepting either a raw key
 * (`block.hero`) or a reference (`${block.hero}`). Handy for tests and for
 * callers that have already loaded all blocks.
 */
export function blockResolverFromMap(
  blocks: Record<string, BlockNode>,
): (ref: string) => BlockNode | null {
  return (ref) => {
    const key = ref.startsWith('${') && ref.endsWith('}') ? ref.slice(2, -1) : ref
    return blocks[key] ?? null
  }
}
