# SAML 2.0 — internal security self-review

Scope: `@edgevault/sso-saml` SAML SP (`src/c14n.ts`, `src/saml.ts`). This is an
**internal** review (audit prep), **not** a substitute for the external XML-DSig
audit + live-IdP interop testing that must precede enabling SAML for real orgs.
The OIDC path in this package (built on `jose`) does **not** carry these caveats.

## Threats addressed

- **Forged / tampered assertion** — the assertion (or enclosing response) must
  carry a valid enveloped XML signature. The reference digest is recomputed over
  the signed element (signature omitted, exclusive-c14n applied) and compared
  constant-time; the `SignatureValue` is verified (RSASSA-PKCS1-v1_5/SHA-256)
  over the canonicalized `SignedInfo`. Any byte change breaks one of these.
- **Signature wrapping (XSW)** — the reference `URI="#id"` must resolve, by a
  **unique** `xs:ID` across the whole document, to the **exact** element the
  signature is enveloped in (`findById` returns exactly one, and it must equal
  the signature's parent). We require **exactly one** `Assertion`, and bind the
  verified signature to either that assertion or the enclosing response.
- **Algorithm confusion / downgrade** — canonicalization, transforms, digest,
  and signature algorithms are **pinned**: exclusive-c14n, enveloped-signature,
  SHA-256, RSA-SHA256. SHA-1 and encrypted assertions are rejected outright.
- **Conditions abuse** — `NotBefore`/`NotOnOrAfter` (assertion + subject
  confirmation) are enforced with a 3-minute skew; `AudienceRestriction` must
  include our SP entityID; `SubjectConfirmationData.Recipient` must equal our
  ACS; `InResponseTo` is checked when the request id is available.
- **Status spoofing** — the response `StatusCode` must be `…:status:Success`.
- **Transport** — the SAML surface (in the auth worker) is behind the
  internal-token mesh and is only reachable via the console BFF; an unconfigured
  org has no connection and cannot complete a flow.

## Residual risks — what the external audit must scrutinize

1. **Hand-rolled exclusive C14N (`c14n.ts`)** — this is the highest-risk
   component. Correctness against the full exc-c14n spec (namespace visibility
   and inheritance, attribute ordering, default-namespace cancellation,
   PI/comment handling, `InclusiveNamespaces` PrefixList) determines whether the
   digest/signature comparison is sound. Our tests prove internal round-trip
   consistency + tamper/wrapping rejection, but **not** byte-for-byte agreement
   with real IdPs. **Required: interop testing against Okta/Entra/Ping and an
   independent review of the canonicalizer.** A c14n that is too lenient could,
   in principle, let a crafted document canonicalize to bytes matching a
   different logical document.
2. **IdP certificate trust** — we extract the SPKI from the admin-supplied IdP
   certificate and verify the signature against it, but we do **not** validate
   the certificate's chain, validity dates, or revocation. This matches common
   SAML practice (the configured cert *is* the trust anchor), but means a
   compromised/expired IdP cert is only mitigated by the admin rotating it.
3. **Assertion replay within validity window** — ✅ **Addressed.** After the
   signature + conditions verify, the ACS handler atomically claims the
   assertion `ID` via `consumeSamlAssertion` (a `saml_assertion_replay` table
   whose primary key is the assertion ID). The first claim wins; any replay of
   the same ID within its validity window fails the unique constraint and the
   login is rejected (`assertion_replayed`). Records are pruned once their
   `NotOnOrAfter` passes. An assertion with no `ID` is rejected outright. The
   Postgres PK makes this race-safe (no two concurrent ACS posts can both win),
   which a read-modify-write KV cache could not guarantee.
4. **`InResponseTo` is optional** — the transaction cookie is `SameSite=None` to
   survive the IdP's cross-site POST, but if absent the check is skipped (the
   assertion is still fully signature+conditions verified). IdP-initiated SSO has
   no `InResponseTo` by design.
5. **DOM parser hardening** — `@xmldom/xmldom` is used with defaults; confirm it
   is not vulnerable to entity-expansion/XXE for the inputs we accept (SAML
   responses are attacker-influenced). xmldom does not resolve external entities
   by default, but this should be explicitly verified.

## Recommendation

- **OIDC SSO**: production-ready (jose-based).
- **SAML SSO**: the surface ships in the auth worker (unused until an admin
  configures a connection), but **do not enable SAML connections for real
  production orgs until** (a) the canonicalizer is independently reviewed and
  (b) interop is validated against the IdPs you must support. The assertion-replay
  cache (residual risk #3) is now in place; the remaining blockers are the
  external c14n review and live-IdP interop testing.
