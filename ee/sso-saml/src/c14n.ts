/**
 * Exclusive XML Canonicalization (https://www.w3.org/TR/xml-exc-c14n/) — the
 * canonical byte form a SAML signature is computed over. Both the `<SignedInfo>`
 * (for the signature itself) and each signed element (for its reference digest)
 * must be canonicalized identically to the IdP, or verification fails.
 *
 * This is a focused implementation of the profile real SAML IdPs emit (exclusive
 * c14n without comments, enveloped-signature transform). It is security-critical
 * and intentionally conservative; see saml.ts for the wrapping-attack defenses
 * layered on top. NOT yet audited — review + real-IdP interop testing required
 * before production use.
 */

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4
const PROCESSING_INSTRUCTION_NODE = 7
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9
const DOCUMENT_FRAGMENT_NODE = 11

/** Structural view of the @xmldom/xmldom node shape we rely on. */
export interface XmlNode {
  nodeType: number
  nodeName: string
  prefix?: string | null
  localName?: string | null
  namespaceURI?: string | null
  tagName?: string
  data?: string | null
  nodeValue?: string | null
  parentNode?: XmlNode | null
  attributes?: ArrayLike<XmlAttr> | null
  childNodes?: ArrayLike<XmlNode> | null
  getAttribute?(name: string): string | null
  hasAttribute?(name: string): boolean
}

export interface XmlAttr {
  name: string
  value: string
  prefix?: string | null
  localName?: string | null
  namespaceURI?: string | null
}

export interface C14nOptions {
  /** A node (the enveloped `<ds:Signature>`) to omit from the output. */
  omit?: XmlNode
  /** InclusiveNamespaces PrefixList — treated as visibly-utilized. */
  prefixList?: string[]
}

function attrs(node: XmlNode): XmlAttr[] {
  const list = node.attributes
  if (!list) return []
  const out: XmlAttr[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i] as XmlAttr)
  return out
}

function children(node: XmlNode): XmlNode[] {
  const list = node.childNodes
  if (!list) return []
  const out: XmlNode[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i] as XmlNode)
  return out
}

function isNamespaceDecl(attr: XmlAttr): boolean {
  return attr.name === 'xmlns' || attr.name.startsWith('xmlns:')
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;')
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
}

/** In-scope value of a namespace prefix at `el`, walking the input ancestors. */
function inScopeNamespace(el: XmlNode, prefix: string): string | null {
  const attrName = prefix === '' ? 'xmlns' : `xmlns:${prefix}`
  let cur: XmlNode | null | undefined = el
  while (cur && cur.nodeType === ELEMENT_NODE) {
    if (cur.hasAttribute?.(attrName)) return cur.getAttribute?.(attrName) ?? ''
    cur = cur.parentNode
  }
  return prefix === '' ? '' : null
}

function renderElement(
  el: XmlNode,
  outNs: Map<string, string>,
  options: C14nOptions,
  out: string[],
): void {
  // Visibly-utilized prefixes: the element's own prefix + each prefixed,
  // non-namespace attribute's prefix + any PrefixList entries.
  const utilized = new Set<string>()
  utilized.add(el.prefix ?? '')
  for (const a of attrs(el)) {
    if (!isNamespaceDecl(a) && a.prefix) utilized.add(a.prefix)
  }
  for (const p of options.prefixList ?? []) utilized.add(p)

  // Decide which namespace declarations to render (exclusive rule: only utilized
  // prefixes whose in-scope value differs from what output ancestors rendered).
  const rendered: Array<{ prefix: string; value: string }> = []
  const childNs = new Map(outNs)
  for (const prefix of utilized) {
    const value = inScopeNamespace(el, prefix)
    if (prefix === '') {
      const current = outNs.get('') ?? ''
      const v = value ?? ''
      if (v !== current) {
        // Render (including xmlns="" to cancel an inherited default).
        if (!(v === '' && current === '')) {
          rendered.push({ prefix: '', value: v })
          childNs.set('', v)
        }
      }
      continue
    }
    if (value === null) continue // utilized but undeclared — skip
    if (outNs.get(prefix) !== value) {
      rendered.push({ prefix, value })
      childNs.set(prefix, value)
    }
  }

  // Sort: default namespace first, then by prefix lexicographically.
  rendered.sort((a, b) => {
    if (a.prefix === '') return -1
    if (b.prefix === '') return 1
    return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0
  })

  // Non-namespace attributes, sorted by (namespace URI, local name).
  const dataAttrs = attrs(el).filter((a) => !isNamespaceDecl(a))
  dataAttrs.sort((a, b) => {
    const au = a.namespaceURI ?? ''
    const bu = b.namespaceURI ?? ''
    if (au !== bu) return au < bu ? -1 : 1
    const al = a.localName ?? a.name
    const bl = b.localName ?? b.name
    return al < bl ? -1 : al > bl ? 1 : 0
  })

  const qname = el.nodeName
  out.push(`<${qname}`)
  for (const ns of rendered) {
    out.push(
      ns.prefix === ''
        ? ` xmlns="${escapeAttr(ns.value)}"`
        : ` xmlns:${ns.prefix}="${escapeAttr(ns.value)}"`,
    )
  }
  for (const a of dataAttrs) out.push(` ${a.name}="${escapeAttr(a.value)}"`)
  out.push('>')

  for (const child of children(el)) renderNode(child, childNs, options, out)

  out.push(`</${qname}>`)
}

function renderNode(
  node: XmlNode,
  outNs: Map<string, string>,
  options: C14nOptions,
  out: string[],
): void {
  if (options.omit && node === options.omit) return
  switch (node.nodeType) {
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE:
      // Canonicalize the contained root element (a Document is not itself output).
      for (const child of children(node)) renderNode(child, outNs, options, out)
      break
    case ELEMENT_NODE:
      renderElement(node, outNs, options, out)
      break
    case TEXT_NODE:
    case CDATA_SECTION_NODE:
      out.push(escapeText(node.data ?? node.nodeValue ?? ''))
      break
    case PROCESSING_INSTRUCTION_NODE: {
      const target = node.nodeName
      const data = node.data ?? ''
      out.push(data ? `<?${target} ${data}?>` : `<?${target}?>`)
      break
    }
    case COMMENT_NODE:
      // Exclusive c14n WITHOUT comments — omit.
      break
    default:
      break
  }
}

/** Canonicalize an element subtree to its exclusive-c14n byte string. */
export function canonicalize(node: XmlNode, options: C14nOptions = {}): string {
  const out: string[] = []
  renderNode(node, new Map(), options, out)
  return out.join('')
}
