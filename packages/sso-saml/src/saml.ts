import { DOMParser } from '@xmldom/xmldom'
import { canonicalize, type XmlNode } from './c14n'

/**
 * SAML 2.0 SP (service provider) — SP-initiated Web Browser SSO.
 *
 * SECURITY: signature verification here is what stands between a forged
 * assertion and an authenticated session. It is hand-rolled on @xmldom/xmldom +
 * WebCrypto and defends against the classic XML signature-wrapping attacks
 * (the reference must resolve, by a unique ID, to the exact element we consume).
 * It supports the common profile real IdPs emit (exclusive c14n, enveloped
 * RSA-SHA256). NOT yet security-audited and NOT yet interop-tested against live
 * Okta/Entra/Ping — both are required before production use. Encrypted assertions
 * and SHA-1 signatures are intentionally unsupported.
 */

const NS = {
  SAMLP: 'urn:oasis:names:tc:SAML:2.0:protocol',
  SAML: 'urn:oasis:names:tc:SAML:2.0:assertion',
  DSIG: 'http://www.w3.org/2000/09/xmldsig#',
  EXC_C14N: 'http://www.w3.org/2001/10/xml-exc-c14n#',
} as const

const ALG = {
  EXC_C14N: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  EXC_C14N_COMMENTS: 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
  ENVELOPED: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  RSA_SHA256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  SHA256: 'http://www.w3.org/2001/04/xmlenc#sha256',
} as const

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'

// --- byte helpers -----------------------------------------------------------

const encoder = new TextEncoder()

// TS 5.7 typed arrays: copy into an ArrayBuffer-backed view so WebCrypto accepts
// it as BufferSource (TextEncoder/atob produce Uint8Array<ArrayBufferLike>).
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(s))
}

function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  void writer.write(bytes)
  void writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

// --- X.509 → public key -----------------------------------------------------
// Minimal DER walk to extract the SubjectPublicKeyInfo from an X.509 cert, which
// is what WebCrypto's importKey('spki', …) expects (the cert wraps the SPKI).

interface Tlv {
  tag: number
  start: number // offset of the tag byte
  contentStart: number
  end: number // exclusive end of this TLV
}

function readTlv(buf: Uint8Array, pos: number): Tlv {
  const tag = buf[pos] ?? 0
  let p = pos + 1
  let len = buf[p++] ?? 0
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = (len << 8) | (buf[p++] ?? 0)
  }
  return { tag, start: pos, contentStart: p, end: p + len }
}

function tlvChildren(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  let p = parent.contentStart
  while (p < parent.end) {
    const t = readTlv(buf, p)
    out.push(t)
    p = t.end
  }
  return out
}

/** Import an RSA public key (for RSA-SHA256 verification) from an X.509 cert. */
export async function importCertPublicKey(certPemOrB64: string): Promise<CryptoKey> {
  const b64 = certPemOrB64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = bytesFromBase64(b64)
  const cert = readTlv(der, 0) // Certificate ::= SEQUENCE
  const tbs = readTlv(der, cert.contentStart) // TBSCertificate ::= SEQUENCE
  const fields = tlvChildren(der, tbs)
  // Optional [0] EXPLICIT version shifts SPKI from index 5 to 6.
  const versionPresent = (fields[0]?.tag ?? 0) === 0xa0
  const spki = fields[versionPresent ? 6 : 5]
  if (!spki) throw new Error('Could not locate SubjectPublicKeyInfo in certificate')
  const spkiDer = der.slice(spki.start, spki.end)
  return crypto.subtle.importKey(
    'spki',
    spkiDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

// --- DOM helpers ------------------------------------------------------------

function asNode(x: unknown): XmlNode {
  return x as XmlNode
}

function firstChildNS(el: XmlNode, ns: string, local: string): XmlNode | null {
  const list = el.childNodes
  if (!list) return null
  for (let i = 0; i < list.length; i++) {
    const c = asNode(list[i])
    if (c.nodeType === 1 && c.namespaceURI === ns && c.localName === local) return c
  }
  return null
}

function descendantsNS(el: XmlNode, ns: string, local: string): XmlNode[] {
  const anyEl = el as unknown as {
    getElementsByTagNameNS(ns: string, local: string): ArrayLike<unknown>
  }
  const list = anyEl.getElementsByTagNameNS(ns, local)
  const out: XmlNode[] = []
  for (let i = 0; i < list.length; i++) out.push(asNode(list[i]))
  return out
}

function attr(el: XmlNode, name: string): string | null {
  return el.getAttribute?.(name) ?? null
}

function text(el: XmlNode | null): string {
  if (!el) return ''
  const withText = el as unknown as { textContent?: string | null }
  return (withText.textContent ?? '').trim()
}

function inclusiveNsPrefixList(methodEl: XmlNode | null): string[] | undefined {
  if (!methodEl) return undefined
  const inc = firstChildNS(methodEl, NS.EXC_C14N, 'InclusiveNamespaces')
  const list = inc ? attr(inc, 'PrefixList') : null
  return list ? list.split(/\s+/).filter(Boolean) : undefined
}

// --- AuthnRequest (SP-initiated, HTTP-Redirect binding) ---------------------

export interface AuthnRequestInput {
  spEntityId: string
  acsUrl: string
  idpSsoUrl: string
  relayState?: string
  /** Override for tests; defaults to a random NCName id. */
  id?: string
  /** Override for tests; defaults to now. */
  issueInstant?: string
  nameIdFormat?: string
}

export interface AuthnRequest {
  id: string
  redirectUrl: string
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `_${hex}`
}

/** Build a SAML AuthnRequest and the HTTP-Redirect URL to send the user to. */
export async function buildAuthnRequest(input: AuthnRequestInput): Promise<AuthnRequest> {
  const id = input.id ?? randomId()
  const issueInstant = input.issueInstant ?? new Date().toISOString()
  const nameIdFormat =
    input.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'

  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${NS.SAMLP}" ID="${id}" Version="2.0"` +
    ` IssueInstant="${issueInstant}" Destination="${input.idpSsoUrl}"` +
    ` AssertionConsumerServiceURL="${input.acsUrl}"` +
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
    `<saml:Issuer xmlns:saml="${NS.SAML}">${input.spEntityId}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${nameIdFormat}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`

  const deflated = await deflateRaw(utf8(xml))
  const samlRequest = base64FromBytes(deflated)
  const params = new URLSearchParams({ SAMLRequest: samlRequest })
  if (input.relayState) params.set('RelayState', input.relayState)
  const sep = input.idpSsoUrl.includes('?') ? '&' : '?'
  return { id, redirectUrl: `${input.idpSsoUrl}${sep}${params.toString()}` }
}

// --- Response verification --------------------------------------------------

export interface VerifyOptions {
  /** IdP signing public key (use importCertPublicKey on the stored cert). */
  idpPublicKey: CryptoKey
  /** Our SP entityID — must match the assertion's AudienceRestriction. */
  audience: string
  /** Our ACS URL — must match SubjectConfirmationData Recipient when present. */
  acsUrl: string
  /** The AuthnRequest id we issued — checked against InResponseTo when set. */
  expectedInResponseTo?: string
  /** Clock for tests; defaults to now. */
  now?: number
  /** Allowed clock skew in ms (default 3 min). */
  clockSkewMs?: number
}

export interface SamlIdentity {
  nameId: string
  email: string | null
  name: string | null
  attributes: Record<string, string[]>
  sessionIndex: string | null
  /** The assertion's `ID` — the key for one-time-use (replay) enforcement. */
  assertionId: string
  /**
   * Earliest `NotOnOrAfter` (Conditions / SubjectConfirmationData), in epoch ms,
   * after which the assertion is expired. Use as the TTL for the replay record.
   * Null if the IdP supplied no expiry (callers should apply a bounded default).
   */
  notOnOrAfter: number | null
}

class SamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SamlError'
  }
}

function parseXml(xml: string): XmlNode {
  try {
    // xmldom ≥0.9 throws on fatal parse errors by default.
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    return doc as unknown as XmlNode
  } catch (e) {
    throw new SamlError(`malformed XML: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Every element in the document carrying the given xs:ID value. */
function findById(doc: XmlNode, id: string): XmlNode[] {
  const all = (
    doc as unknown as { getElementsByTagName(n: string): ArrayLike<unknown> }
  ).getElementsByTagName('*')
  const out: XmlNode[] = []
  for (let i = 0; i < all.length; i++) {
    const el = asNode(all[i])
    if (attr(el, 'ID') === id) out.push(el)
  }
  return out
}

/** Verify one enveloped XML signature over `signedEl`. Returns true if valid. */
async function verifyEnvelopedSignature(
  doc: XmlNode,
  sigEl: XmlNode,
  signedEl: XmlNode,
  publicKey: CryptoKey,
): Promise<boolean> {
  const signedInfo = firstChildNS(sigEl, NS.DSIG, 'SignedInfo')
  if (!signedInfo) return false

  const c14nMethod = firstChildNS(signedInfo, NS.DSIG, 'CanonicalizationMethod')
  const c14nAlg = c14nMethod ? attr(c14nMethod, 'Algorithm') : null
  if (c14nAlg !== ALG.EXC_C14N && c14nAlg !== ALG.EXC_C14N_COMMENTS) return false

  const sigMethod = firstChildNS(signedInfo, NS.DSIG, 'SignatureMethod')
  if (!sigMethod || attr(sigMethod, 'Algorithm') !== ALG.RSA_SHA256) return false

  // Exactly one reference, pointing at the signed element by a unique ID.
  const refs = descendantsNS(signedInfo, NS.DSIG, 'Reference')
  if (refs.length !== 1) return false
  const ref = refs[0] as XmlNode
  const uri = attr(ref, 'URI') ?? ''
  if (!uri.startsWith('#')) return false
  const refId = uri.slice(1)

  // Wrapping defense: the id must resolve to exactly one element, and it must be
  // the very element the signature is enveloped in (its parent).
  const byId = findById(doc, refId)
  if (byId.length !== 1 || byId[0] !== signedEl) return false
  if (attr(signedEl, 'ID') !== refId) return false

  // Reference transforms must be enveloped-signature + exclusive c14n.
  const transforms = descendantsNS(ref, NS.DSIG, 'Transform').map((t) => attr(t, 'Algorithm'))
  if (!transforms.includes(ALG.ENVELOPED)) return false
  if (!transforms.includes(ALG.EXC_C14N) && !transforms.includes(ALG.EXC_C14N_COMMENTS)) {
    return false
  }
  const digestMethod = firstChildNS(ref, NS.DSIG, 'DigestMethod')
  if (!digestMethod || attr(digestMethod, 'Algorithm') !== ALG.SHA256) return false
  const digestValue = text(firstChildNS(ref, NS.DSIG, 'DigestValue'))
  if (!digestValue) return false

  // Recompute the reference digest over the signed element with the signature
  // removed (enveloped transform) and exclusive-c14n applied.
  const refTransform = descendantsNS(ref, NS.DSIG, 'Transform').find(
    (t) => attr(t, 'Algorithm') === ALG.EXC_C14N || attr(t, 'Algorithm') === ALG.EXC_C14N_COMMENTS,
  )
  const refCanon = canonicalize(signedEl, {
    omit: sigEl,
    prefixList: inclusiveNsPrefixList(refTransform ?? null),
  })
  const computedDigest = await sha256(utf8(refCanon))
  if (!timingSafeEqual(computedDigest, bytesFromBase64(digestValue))) return false

  // Verify the signature over the canonicalized SignedInfo.
  const signedInfoCanon = canonicalize(signedInfo, {
    prefixList: inclusiveNsPrefixList(c14nMethod),
  })
  const signatureValue = text(firstChildNS(sigEl, NS.DSIG, 'SignatureValue'))
  if (!signatureValue) return false
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    bytesFromBase64(signatureValue),
    utf8(signedInfoCanon),
  )
}

function checkTimeWindow(
  el: XmlNode,
  now: number,
  skew: number,
  notBeforeAttr = 'NotBefore',
  notAfterAttr = 'NotOnOrAfter',
): boolean {
  const nb = attr(el, notBeforeAttr)
  const na = attr(el, notAfterAttr)
  if (nb) {
    const t = Date.parse(nb)
    if (Number.isFinite(t) && now + skew < t) return false
  }
  if (na) {
    const t = Date.parse(na)
    if (Number.isFinite(t) && now - skew >= t) return false
  }
  return true
}

/** The element's `NotOnOrAfter` as epoch ms, or null if absent/unparseable. */
function notOnOrAfterMs(el: XmlNode | null): number | null {
  if (!el) return null
  const na = attr(el, 'NotOnOrAfter')
  if (!na) return null
  const t = Date.parse(na)
  return Number.isFinite(t) ? t : null
}

const EMAIL_ATTR_NAMES = new Set([
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
])
const NAME_ATTR_NAMES = new Set([
  'name',
  'displayname',
  'cn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
])

function looksLikeEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
}

/**
 * Parse and fully validate a SAML Response: verify the signature over the
 * assertion (or the enclosing response), then the status, conditions, audience,
 * subject recipient, and time windows. Returns the verified identity or throws.
 */
export async function verifySamlResponse(
  xml: string,
  options: VerifyOptions,
): Promise<SamlIdentity> {
  const now = options.now ?? Date.now()
  const skew = options.clockSkewMs ?? 3 * 60 * 1000
  const doc = parseXml(xml)

  const responses = descendantsNS(doc, NS.SAMLP, 'Response')
  if (responses.length !== 1) throw new SamlError('expected exactly one Response')
  const response = responses[0] as XmlNode

  // Status must be Success.
  const statusCode = descendantsNS(response, NS.SAMLP, 'StatusCode')[0] ?? null
  if (!statusCode || attr(statusCode, 'Value') !== STATUS_SUCCESS) {
    throw new SamlError('SAML status was not Success')
  }

  if (descendantsNS(response, NS.SAML, 'EncryptedAssertion').length > 0) {
    throw new SamlError('encrypted assertions are not supported')
  }
  const assertions = descendantsNS(response, NS.SAML, 'Assertion')
  if (assertions.length !== 1) throw new SamlError('expected exactly one Assertion')
  const assertion = assertions[0] as XmlNode

  // Find a valid signature that covers the assertion — either enveloped directly
  // in the assertion, or in the response (which contains exactly this assertion).
  const signatures = descendantsNS(response, NS.DSIG, 'Signature')
  let verified = false
  for (const sig of signatures) {
    const signedEl = asNode(sig.parentNode)
    if (signedEl !== assertion && signedEl !== response) continue
    if (await verifyEnvelopedSignature(doc, sig, signedEl, options.idpPublicKey)) {
      verified = true
      break
    }
  }
  if (!verified) throw new SamlError('no valid signature covering the assertion')

  // Conditions: time window + audience.
  const conditions = firstChildNS(assertion, NS.SAML, 'Conditions')
  if (conditions) {
    if (!checkTimeWindow(conditions, now, skew)) throw new SamlError('assertion conditions expired')
    const audiences = descendantsNS(conditions, NS.SAML, 'Audience').map((a) => text(a))
    if (audiences.length > 0 && !audiences.includes(options.audience)) {
      throw new SamlError('audience restriction not satisfied')
    }
  }

  // Subject confirmation: recipient + time window + InResponseTo.
  const subject = firstChildNS(assertion, NS.SAML, 'Subject')
  const confData = subject
    ? (() => {
        const sc = firstChildNS(subject, NS.SAML, 'SubjectConfirmation')
        return sc ? firstChildNS(sc, NS.SAML, 'SubjectConfirmationData') : null
      })()
    : null
  if (confData) {
    const recipient = attr(confData, 'Recipient')
    if (recipient && recipient !== options.acsUrl) throw new SamlError('unexpected ACS recipient')
    if (!checkTimeWindow(confData, now, skew)) throw new SamlError('subject confirmation expired')
    const inResponseTo = attr(confData, 'InResponseTo')
    if (options.expectedInResponseTo && inResponseTo !== options.expectedInResponseTo) {
      throw new SamlError('InResponseTo mismatch')
    }
  }

  // Extract identity.
  const nameId = text(subject ? firstChildNS(subject, NS.SAML, 'NameID') : null)
  const attributes: Record<string, string[]> = {}
  for (const a of descendantsNS(assertion, NS.SAML, 'Attribute')) {
    const name = (attr(a, 'Name') ?? '').trim()
    if (!name) continue
    attributes[name] = descendantsNS(a, NS.SAML, 'AttributeValue').map((v) => text(v))
  }

  const findAttr = (names: Set<string>): string | null => {
    for (const [k, v] of Object.entries(attributes)) {
      if (names.has(k.toLowerCase()) && v[0]) return v[0]
    }
    return null
  }
  const email = findAttr(EMAIL_ATTR_NAMES) ?? (looksLikeEmail(nameId) ? nameId : null)
  const name = findAttr(NAME_ATTR_NAMES)
  const authnStatement = firstChildNS(assertion, NS.SAML, 'AuthnStatement')
  const sessionIndex = authnStatement ? attr(authnStatement, 'SessionIndex') : null

  // Replay-enforcement metadata: the assertion ID, and the earliest expiry
  // across Conditions + SubjectConfirmationData (the window the IdP vouches for).
  const assertionId = attr(assertion, 'ID') ?? ''
  const expiries = [notOnOrAfterMs(conditions), notOnOrAfterMs(confData)].filter(
    (t): t is number => t !== null,
  )
  const notOnOrAfter = expiries.length > 0 ? Math.min(...expiries) : null

  return { nameId, email, name, attributes, sessionIndex, assertionId, notOnOrAfter }
}
