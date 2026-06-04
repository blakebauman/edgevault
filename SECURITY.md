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

In scope: the open-source core (`apps/*`, `packages/*`) and the enterprise
edition (`ee/*`). The managed-service control plane (`edge/*`) is operated by
us; report issues there to the same address.

## Threat Model (living document)

EdgeVault's security posture rests on:

- **Custom auth** built on audited primitives (`jose`, `@noble/hashes`,
  `@oslojs/*`) — no third-party auth framework, no telemetry.
- **Envelope encryption** for customer secrets (per-secret DEK wrapped by a
  per-workspace KEK; rotation by re-wrapping). Plaintext secrets are never
  persisted and never leave the `api`/Durable Object boundary unencrypted.
- **Zero-trust access**: environment-scoped API keys, MCP OAuth scoping, RBAC.
- **Tenant isolation** via per-workspace SQLite Durable Objects.

A full, versioned threat model is published before the first public release
(see plan Phase 10).

## Supported Versions

Pre-1.0: only the latest `main` is supported. A version-support matrix lands
with the first tagged release.
