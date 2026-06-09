# Security Policy

EdgeVault manages configuration **and secrets** at the edge. Security is a
first-class concern and this document will harden as the platform matures.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Email **security@edgevault.dev** (PGP key TBD) with:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected component(s) and version/commit

We aim to acknowledge within 48 hours and to provide a remediation timeline
within 5 business days. We follow coordinated disclosure and will credit
reporters who wish to be named.

## Scope

In scope: the open-source core (`apps/*`, `packages/*`), which includes all
product features (enterprise SSO/SAML, SCIM). The managed-service control plane
(`edge/*`) is operated by us; report issues there to the same address.

## Threat Model

This is a living document, versioned with the source. It states what we protect,
the boundaries we defend, the concrete mechanisms, and the residual risks we
have **not** yet closed. Numbers reflect the current `main`.

### Assets

1. **Customer secrets** — the "vault" payloads. Highest-value asset.
2. **Customer configuration & feature flags** — integrity matters (a flipped
   kill-switch or flag is a production incident).
3. **Identity material** — passwords, session tokens, API keys, the JWT signing
   key, OIDC/SAML connection client secrets.
4. **Tenant isolation** — one workspace must never read or write another's data.

### Trust boundaries

- **Browser ↔ console BFF** — the browser only ever talks to the console origin.
  The console (a Worker) proxies to `auth`/`api`/`enterprise` over **service
  bindings**, so those workers are never exposed to cross-site requests or CORS.
- **Console ↔ internal workers** — `auth`, `api`, and `enterprise` SSO/SCIM
  surfaces are authenticated by a shared `INTERNAL_TOKEN` (constant-time
  compared) and reached only via service bindings (no public route on
  `enterprise`).
- **`api` ↔ Workspace Durable Object** — config/secret writes are RPC into the
  per-workspace DO; plaintext secrets exist only transiently inside the
  `api`/DO boundary and are never persisted in the clear.
- **Edge delivery** — `delivery` serves only **pre-resolved** values from KV,
  gated by environment-scoped API keys. It holds no business logic and cannot
  decrypt secrets.
- **External IdPs / MCP clients** — untrusted until a signature (OIDC/SAML) or a
  scoped OAuth grant (MCP) is verified.

### Cryptographic primitives

| Use | Primitive |
|---|---|
| Password hashing | **Argon2id** (`@noble/hashes`), m=19 MiB, t=2, p=1, 32-byte hash, 16-byte salt (OWASP params) |
| Session / API-key / token storage | **SHA-256** hash at rest; raw value shown once, never stored |
| JWTs (service-to-service) | **EdDSA / Ed25519** (`jose`); public **JWKS** endpoint, signing key write-only |
| Secret envelope | `MASTER_KEK` (32-byte) → **HKDF-SHA256** derives a per-workspace KEK (salted by workspace id) → **AES-GCM-256** wraps a per-secret DEK; the DEK encrypts the payload (12-byte IV) |
| Constant-time compares | tokens/secrets compared with timing-safe equality, never `===` |

### Threats & mitigations

- **Credential theft / brute force** — Argon2id at OWASP cost; opaque session
  tokens (SHA-256 at rest) cached in KV with short TTL + a revocation path;
  per-IP rate limiting on auth endpoints; MFA (TOTP) and WebAuthn/passkeys.
- **Token forgery** — EdDSA JWTs verified against the published JWKS; the
  signing key is a write-only secret and the JWKS strips private/`key_ops`
  fields so a published key can only verify, never sign.
- **Secret disclosure** — envelope encryption means a database/DO compromise
  yields only ciphertext + wrapped DEKs; the `MASTER_KEK` lives in Secrets
  Store, not in the data store. Decryption is RBAC-gated and audit-logged.
  KEK rotation re-wraps DEKs without re-encrypting payloads.
- **Cross-tenant access** — per-workspace SQLite Durable Objects (addressed by
  workspace id) physically separate tenant data; the KEK is workspace-derived,
  so even a leaked DEK is scoped to one workspace.
- **SSO attacks** — OIDC uses authorization-code + PKCE with `state`/`nonce`.
  SAML signature verification (XML-DSig) is implemented but **not yet enabled
  for production orgs** — see
  [`packages/sso-saml/SECURITY-REVIEW.md`](packages/sso-saml/SECURITY-REVIEW.md).
  The SCIM directory surface is authenticated by a per-org bearer token whose
  SHA-256 is compared constant-time; no stored hash means SCIM is denied.
- **Supply chain** — auth is built on a small set of audited primitives
  (`jose`, `@noble/hashes`, `@oslojs/*`) rather than a large framework; a CI
  boundary check (`pnpm boundary`) enforces that the MIT core never imports
  `edge/`.

### Residual risks & non-goals

- **SAML XML-DSig** — the hand-rolled exclusive-c14n needs an external audit and
  an assertion-replay cache before SAML is enabled for real orgs. Tracked in
  `packages/sso-saml/SECURITY-REVIEW.md`. Until then, OIDC is the supported
  enterprise SSO path.
- **Custom auth ownership** — building auth ourselves means we own every CVE
  class (session fixation, OAuth/OIDC state/PKCE correctness, timing). Mitigated
  by audited primitives and per-change review, but it is an accepted trade-off
  for zero-telemetry control.
- **Usage metering is not billing-grade from Analytics Engine alone** — AE is
  sampled at high volume; billable counters must derive from the durable audit
  pipeline. (Managed Edge / `edge/*` only.)
- **No air-gapped / on-prem** — EdgeVault is Cloudflare-native; self-hosting
  means bring-your-own-Cloudflare-account.

## Supported Versions

Pre-1.0: only the latest `main` is supported. A version-support matrix lands
with the first tagged release.
