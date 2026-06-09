import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { canonicalize, type XmlNode } from '../src/c14n'
import { buildAuthnRequest, importCertPublicKey, verifySamlResponse } from '../src/index'

// --- small helpers ----------------------------------------------------------

const enc = new TextEncoder()
const utf8 = (s: string) => new Uint8Array(enc.encode(s))
const b64 = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const parse = (xml: string) =>
  new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlNode

const DSIG = 'http://www.w3.org/2000/09/xmldsig#'
const AUDIENCE = 'https://sp.edgevault.test'
const ACS = 'https://sp.edgevault.test/acs'

async function genKey() {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
}

interface ResponseOpts {
  assertionId?: string
  email?: string
  displayName?: string
  audience?: string
  recipient?: string
  notBefore?: string
  notOnOrAfter?: string
  inResponseTo?: string
  extraAssertion?: boolean
}

/** Produce a SAML Response with a correctly-signed assertion (enveloped, exc-c14n, RSA-SHA256). */
async function signedResponse(privateKey: CryptoKey, opts: ResponseOpts = {}): Promise<string> {
  const id = opts.assertionId ?? '_assertion1'
  const email = opts.email ?? 'ada@example.com'
  const displayName = opts.displayName ?? 'Ada Lovelace'
  const audience = opts.audience ?? AUDIENCE
  const recipient = opts.recipient ?? ACS
  const notBefore = opts.notBefore ?? new Date(Date.now() - 60_000).toISOString()
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(Date.now() + 5 * 60_000).toISOString()
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : ''

  const inner =
    `<saml:Issuer>https://idp.example.com</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="${recipient}"${irt} NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement SessionIndex="sess-1" AuthnInstant="${notBefore}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password` +
    `</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>${displayName}</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>`

  const assertionNoSig =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0"` +
    ` IssueInstant="${notBefore}">${inner}</saml:Assertion>`

  // Reference digest over the (signature-free) assertion.
  const digest = b64(await sha256(utf8(canonicalize(parse(assertionNoSig)))))

  const signedInfo =
    `<ds:SignedInfo xmlns:ds="${DSIG}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<ds:Reference URI="#${id}"><ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`

  const sigBytes = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      utf8(canonicalize(parse(signedInfo))),
    ),
  )
  const signature = `<ds:Signature xmlns:ds="${DSIG}">${signedInfo}<ds:SignatureValue>${b64(sigBytes)}</ds:SignatureValue></ds:Signature>`

  // Enveloped: place the signature inside the assertion (right after Issuer).
  const assertion = assertionNoSig.replace('</saml:Issuer>', `</saml:Issuer>${signature}`)
  const evil = opts.extraAssertion
    ? `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil" Version="2.0" IssueInstant="${notBefore}"><saml:Issuer>https://idp.example.com</saml:Issuer><saml:Subject><saml:NameID>attacker@evil.test</saml:NameID></saml:Subject></saml:Assertion>`
    : ''

  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_resp1" Version="2.0"` +
    ` IssueInstant="${notBefore}"><samlp:Status>` +
    `<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `${assertion}${evil}</samlp:Response>`
  )
}

describe('buildAuthnRequest', () => {
  it('builds a deflated, base64 SAMLRequest redirect', async () => {
    const { id, redirectUrl } = await buildAuthnRequest({
      spEntityId: AUDIENCE,
      acsUrl: ACS,
      idpSsoUrl: 'https://idp.example.com/sso',
      relayState: 'back-to-here',
    })
    expect(id).toMatch(/^_[0-9a-f]+$/)
    const u = new URL(redirectUrl)
    expect(u.origin + u.pathname).toBe('https://idp.example.com/sso')
    expect(u.searchParams.get('RelayState')).toBe('back-to-here')

    const deflated = Uint8Array.from(atob(u.searchParams.get('SAMLRequest') ?? ''), (c) =>
      c.charCodeAt(0),
    )
    const ds = new DecompressionStream('deflate-raw')
    const w = ds.writable.getWriter()
    void w.write(deflated)
    void w.close()
    const xml = await new Response(ds.readable).text()
    expect(xml).toContain('<samlp:AuthnRequest')
    expect(xml).toContain(`AssertionConsumerServiceURL="${ACS}"`)
  })
})

describe('verifySamlResponse', () => {
  it('accepts a correctly-signed assertion and extracts identity', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = await signedResponse(privateKey, { inResponseTo: '_req1' })
    const identity = await verifySamlResponse(xml, {
      idpPublicKey: publicKey,
      audience: AUDIENCE,
      acsUrl: ACS,
      expectedInResponseTo: '_req1',
    })
    expect(identity.email).toBe('ada@example.com')
    expect(identity.name).toBe('Ada Lovelace')
    expect(identity.nameId).toBe('ada@example.com')
    expect(identity.sessionIndex).toBe('sess-1')
  })

  it('surfaces the assertion ID and expiry for replay enforcement', async () => {
    const { privateKey, publicKey } = await genKey()
    const notOnOrAfter = new Date(Date.now() + 5 * 60_000).toISOString()
    const xml = await signedResponse(privateKey, { assertionId: '_assertion-xyz', notOnOrAfter })
    const identity = await verifySamlResponse(xml, {
      idpPublicKey: publicKey,
      audience: AUDIENCE,
      acsUrl: ACS,
    })
    expect(identity.assertionId).toBe('_assertion-xyz')
    expect(identity.notOnOrAfter).toBe(Date.parse(notOnOrAfter))
  })

  it('rejects a tampered attribute (digest mismatch)', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = (await signedResponse(privateKey)).replace('ada@example.com', 'mallory@evil.test')
    await expect(
      verifySamlResponse(xml, { idpPublicKey: publicKey, audience: AUDIENCE, acsUrl: ACS }),
    ).rejects.toThrow(/no valid signature/)
  })

  it('rejects a forged signature value', async () => {
    const { privateKey, publicKey } = await genKey()
    let xml = await signedResponse(privateKey)
    xml = xml.replace(/<ds:SignatureValue>[^<]+<\/ds:SignatureValue>/, (m) =>
      m.replace(/[A-Za-z]/, (ch) => (ch === 'A' ? 'B' : 'A')),
    )
    await expect(
      verifySamlResponse(xml, { idpPublicKey: publicKey, audience: AUDIENCE, acsUrl: ACS }),
    ).rejects.toThrow()
  })

  it('rejects verification with a different key', async () => {
    const { privateKey } = await genKey()
    const other = await genKey()
    const xml = await signedResponse(privateKey)
    await expect(
      verifySamlResponse(xml, { idpPublicKey: other.publicKey, audience: AUDIENCE, acsUrl: ACS }),
    ).rejects.toThrow(/no valid signature/)
  })

  it('rejects a signature-wrapping attempt (a second injected assertion)', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = await signedResponse(privateKey, { extraAssertion: true })
    await expect(
      verifySamlResponse(xml, { idpPublicKey: publicKey, audience: AUDIENCE, acsUrl: ACS }),
    ).rejects.toThrow(/exactly one Assertion/)
  })

  it('rejects an expired assertion', async () => {
    const { privateKey, publicKey } = await genKey()
    const past = new Date(Date.now() - 60 * 60_000).toISOString()
    const xml = await signedResponse(privateKey, {
      notBefore: new Date(Date.now() - 120 * 60_000).toISOString(),
      notOnOrAfter: past,
    })
    await expect(
      verifySamlResponse(xml, { idpPublicKey: publicKey, audience: AUDIENCE, acsUrl: ACS }),
    ).rejects.toThrow(/expired/)
  })

  it('rejects a wrong audience', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = await signedResponse(privateKey)
    await expect(
      verifySamlResponse(xml, {
        idpPublicKey: publicKey,
        audience: 'https://attacker.test',
        acsUrl: ACS,
      }),
    ).rejects.toThrow(/audience/)
  })

  it('rejects a wrong ACS recipient', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = await signedResponse(privateKey)
    await expect(
      verifySamlResponse(xml, {
        idpPublicKey: publicKey,
        audience: AUDIENCE,
        acsUrl: 'https://attacker.test/acs',
      }),
    ).rejects.toThrow(/recipient/)
  })

  it('rejects an InResponseTo mismatch', async () => {
    const { privateKey, publicKey } = await genKey()
    const xml = await signedResponse(privateKey, { inResponseTo: '_real' })
    await expect(
      verifySamlResponse(xml, {
        idpPublicKey: publicKey,
        audience: AUDIENCE,
        acsUrl: ACS,
        expectedInResponseTo: '_different',
      }),
    ).rejects.toThrow(/InResponseTo/)
  })
})

// --- minimal DER cert encoder, to exercise importCertPublicKey --------------

function derLen(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  let x = n
  while (x > 0) {
    bytes.unshift(x & 0xff)
    x >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}
function tlv(tag: number, content: number[]): number[] {
  return [tag, ...derLen(content.length), ...content]
}

describe('importCertPublicKey', () => {
  it('extracts the SPKI from a v3 X.509 cert and verifies with it', async () => {
    const { privateKey, publicKey } = await genKey()
    const spki = [...new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))]

    const sha256Rsa = tlv(0x30, [
      ...tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
      ...tlv(0x05, []),
    ])
    const version = tlv(0xa0, tlv(0x02, [0x02])) // [0] EXPLICIT v3
    const serial = tlv(0x02, [0x01])
    const name = tlv(0x30, []) // empty issuer/subject
    const utc = (s: string) => tlv(0x17, [...enc.encode(s)])
    const validity = tlv(0x30, [...utc('240101000000Z'), ...utc('340101000000Z')])
    const tbs = tlv(0x30, [
      ...version,
      ...serial,
      ...sha256Rsa,
      ...name,
      ...validity,
      ...name,
      ...spki,
    ])
    const cert = tlv(0x30, [...tbs, ...sha256Rsa, ...tlv(0x03, [0x00, 0x00])])
    const pem = `-----BEGIN CERTIFICATE-----\n${b64(Uint8Array.from(cert))}\n-----END CERTIFICATE-----`

    const imported = await importCertPublicKey(pem)
    const data = utf8('hello')
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data))
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, sig, data)).toBe(true)
  })
})
