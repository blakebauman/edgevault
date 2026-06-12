---
title: Architecture
description: Five workers, two Durable Object classes, and exactly one source of truth per workspace — where EdgeVault stores what, and why.
order: 2
---

EdgeVault is five Cloudflare Workers plus two Durable Object classes. The browser only ever talks
to the console; everything else communicates over service bindings inside Cloudflare's network —
no CORS, no cross-site cookies.

## The workers

| Worker | Domain | Role |
| --- | --- | --- |
| `api` | api.edgevault.io | Control plane: authz, all writes, AI, promotions, MCP |
| `delivery` | delivery.edgevault.io | Data plane: <10 ms reads, no business logic, cannot decrypt |
| `auth` | auth.edgevault.io | Argon2id passwords, opaque sessions, EdDSA JWT/JWKS, MFA, passkeys |
| `console` | console.edgevault.io | The UI + BFF — the only origin a browser sees |
| `audit` | — | Queue consumer → append-only NDJSON warehouse in R2 |

## The system of record

Every workspace gets a **`VaultDurableObject`** — a SQLite Durable Object holding
environments, config/flag/secret items, versioned revisions, promotions, and the activity log. One
DO per workspace means strong consistency where it matters: two writers to the same workspace are
serialized; the history is a single ordered log.

## The write path

1. **Write** — client (or MCP agent) calls the API; authz + validation run there.
2. **Record** — the workspace DO appends a revision with actor and reason, and broadcasts the
   change to realtime subscribers.
3. **Resolve** — the API recomputes the effective value per environment.
4. **Propagate** — the resolved value is written through to KV at the edge.

## The read path

SDK → delivery worker → in-memory L1 → KV. The delivery worker holds no key material and has no
code path to decryption — a compromised edge node yields resolved configs and flags, never
secrets. Reads are eventually consistent (KV propagation), writes are strongly consistent (the
DO).

## Where data lives

| Store | Holds |
| --- | --- |
| Neon Postgres (via Hyperdrive) | users, orgs, sessions, API-key hashes, workspace metadata, SSO/SAML/SCIM connections, billing plan + Stripe customer |
| Vault DO SQLite | config content, revisions, secret **ciphertext** |
| Workers KV | pre-resolved edge values (write-through on every change) |
| Secrets Store | signing keys, the master KEK |
| R2 | the append-only NDJSON audit warehouse |

Secrets use envelope encryption: a per-secret AES-GCM-256 DEK wrapped by an HKDF-derived
per-workspace KEK. Plaintext exists only transiently inside the API boundary. The full threat
model is on [the security page](/security#blast-radius).
