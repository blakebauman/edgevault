# ROADMAP — Implementation Plans

Derived from a gap analysis against leading secrets-management platforms (Tiers 1–2,
2026-06), plus security patterns borrowed from commercial password managers and applied
to our existing secrets plane (Tier 3, 2026-06) — filtered through EdgeVault's
positioning: edge-native config/flags/secrets with a <10ms delivery plane, AI-native
workflows, open-core on Cloudflare. Each plan is grounded in the current architecture
(see CLAUDE.md). Effort: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks.

**Status:** all of Tier 1 (1.1–1.5) has shipped; Tier 2 and Tier 3 are open.

**Suggested order (remaining):** 2.7 → 2.6 → 2.10 → 2.9 → 2.8 → 2.11, with Tier 3 as a
parallel track (3.2 → 3.1 → 3.3).

---

## Tier 1 — MIT core

### 1.1 Secret referencing (`${KEY}` interpolation) — M/L — ✅ shipped

One config item references another; the delivery plane keeps serving fully pre-resolved
values, so resolution happens entirely at write time in `apps/api`.

**Syntax.** `${KEY}` (same environment), `${env-slug/KEY}` (cross-environment, same
workspace). v1 scope: references allowed **only between config/flag items** — a secret
referenced into a config would leak plaintext into KV; reject at write time with a clear
error. Cross-workspace refs: out of scope.

**Where it plugs in.** The resolved-value pipeline already exists:
`apps/api/src/edge-cache.ts:14` (`writeThrough`) is called after `setConfig` in
`apps/api/src/routes/workspaces.ts:98` and after promotion apply in
`apps/api/src/workflows/promotion.ts:87`. Insert a resolve step before each.

**Build:**
1. `packages/refs` (or extend `@edgevault/edge-protocol`): `extractRefs(content)` parser,
   `resolveRefs(content, lookup)` with DFS cycle detection and depth cap (~10). Pure,
   unit-tested, no bindings.
2. Workspace DO (`apps/api/src/durable-objects/workspace.ts`): new table
   `config_references (item_id, environment_id, config_key, ref_environment_id, ref_key)`,
   maintained inside `setConfig`/`deleteConfig`. New RPCs: `getDependents(envId, key)`,
   `resolveItems(refs[])` (batch read for the resolver).
3. API write path: validate refs at write (unknown ref → 400, cycle → 400, secret ref →
   400). After `writeThrough` of the changed item, fetch dependents and re-resolve +
   re-publish each via `waitUntil` (bounded fan-out, cap ~100 dependents; log overflow).
4. Storage model: `config_items.content_data` stays **raw** (with `${...}`); KV gets the
   resolved value. Revisions/diffs stay on raw content.
5. Console: resolved-value preview on the item editor; "referenced by N" chip.
   MCP `get_config` returns `{ raw, resolved }`.

**Tests:** parser/cycle units in `packages/refs`; pool-workers test that editing a
referenced item republishes dependents to `CONFIGS_CACHE`; promotion of an item with refs
resolves against the *target* environment.

**Risks:** delete-while-referenced (block delete or publish dependents with a broken-ref
marker — pick block, simpler); promotion semantics (refs resolve in target env — document).

---

### 1.2 Environment comparison — S — ✅ shipped

`packages/diff` already exports `generateDiff`/`summarizeDiff` (`packages/diff/src/index.ts:25`).

**Build:**
1. DO RPC `compareEnvironments(sourceEnvId, targetEnvId)`: walk `config_items` for both
   envs, classify per key (only-in-source / only-in-target / drifted / equal) by
   `content_hash`. **Secrets compare by hash only — never decrypt for comparison.**
2. Route `GET /api/v1/workspaces/:id/environments/compare?source=&target=`
   (member-gated, zod-validated, same pattern as `apps/api/src/routes/workspaces.ts`).
   Include per-key `DiffResult[]` for config/flag values; hash-equality boolean for secrets.
3. Console `dashboard/:id/compare`: env pickers, side-by-side table, drift badges, and a
   "Promote" action per drifted key that feeds the existing promotion flow (this is the
   compounding part — compare → promote with confidence).
4. MCP tool `compare_environments` (agents love this for "what's different in prod?").

**Tests:** pool-workers DO test seeding two envs; route authz test.

---

### 1.3 Webhooks + Slack notifications — M — ✅ shipped

**Data model (Neon, `packages/database`):** `notification_channels`
`(id, workspaceId FK, type 'webhook'|'slack', target /* URL, envelope-encrypted via
@edgevault/crypto keyed by workspaceId — webhook URLs are credentials */, signingSecret,
events jsonb /* filter list */, enabled, createdByUserId, createdAt)`. Migration 0008.

**Dispatch architecture.** Reuse the queue pattern, keep `apps/audit` dumb:
1. New queue `edgevault-notify` (producer binding `NOTIFY_QUEUE` in `apps/api`).
2. `apps/api` materializes delivery jobs at emit time — it already holds the Hyperdrive DB
   handle and the decrypted channel config: alongside `emitAudit`
   (`apps/api/src/audit.ts`), a `notify(env, db, event)` helper loads matching enabled
   channels (cache channel list per workspace in-memory per isolate, 30s) and enqueues
   `{ type, url, signingSecret, payload }` jobs.
3. New consumer: `apps/notify` worker (tiny; queue consumer only, 3 retries + DLQ
   `edgevault-notify-dlq`). Generic webhook: POST JSON with
   `x-edgevault-signature: sha256=HMAC(secret, timestamp + '.' + body)` +
   `x-edgevault-timestamp` (replay protection). Slack: Block Kit formatting per event type.
4. Event sources: config.changed/deleted, promotion.completed, `secret.revealed`, and a
   **new** `promotion.awaiting_approval` emitted when `PromotionWorkflow` enters the
   `await-approval` gate (`apps/api/src/workflows/promotion.ts:69`) — the Slack message
   links to the console approval page. This is the highest-value notification.
5. Console: workspace settings → Notifications page (add channel, event filter, "send
   test", delivery status). Routes: CRUD under `/api/v1/workspaces/:id/channels`
   (admin/owner only — same role guard as secret reveal).

**Tests:** HMAC signing unit; pool-workers test with a miniflare queue + stubbed fetch;
Slack payload snapshot tests.

**Note:** no email infra exists in the repo; Slack + webhook covers the need.
Cloudflare Email Service can be a later channel type behind the same table.

---

### 1.4 CLI with `edgevault run` — M/L — ✅ shipped

**Package:** `packages/cli` → `@edgevault/cli`, bin `edgevault`. Node 22, near-zero deps
(built-in `fetch`, `util.parseArgs`, `node:child_process`). Published to npm (MIT).

**Auth modes (two planes):**
- **Machine mode** — environment API key (`EDGEVAULT_API_KEY` or keychain) → existing
  delivery plane. Read-only, perfect for CI. Ships first.
- **Human mode** — user JWT from `apps/auth` → api plane (read/write, secret reveal).
  v1: `edgevault login --token <pat>`; v1.1: browser flow (CLI opens console URL with a
  localhost callback that mints a long-lived CLI token — needs a small `apps/auth`
  addition; don't block v1 on it).

**The blocker to solve first — export endpoints:**
- Delivery has only `GET /v1/configs/:key` + `POST /v1/batch` (explicit keys). Add
  `GET /v1/export` to `apps/delivery`: all config/flag values for the key's environment,
  same L1/KV path. Requires an env-index KV entry (`index:{ws}:{env}` → key list)
  maintained by `writeThrough`/delete in `apps/api/src/edge-cache.ts`.
- Secrets can't come from delivery (it cannot decrypt — by design). Add api-plane
  `GET /api/v1/workspaces/:id/environments/:envId/export?includeSecrets=true`
  (owner/admin or human-mode token, decrypts via `packages/crypto`, emits a single
  `environment.exported` audit event with key count). CLI merges both sources.

**Commands v1:** `login`, `run [--env <slug>] -- <cmd>` (export → inject into child env →
spawn with inherited stdio → propagate exit code), `pull [--format dotenv|json]`,
`get <key>`, `set <key> <value> [--secret]` (human mode), `open` (console deep link).

**Project file:** `.edgevault.json` `{ workspaceId, environment }` checked in; tokens in
`~/.config/edgevault/credentials` (0600) — never in the project file.

**Follow-on (cheap once CLI exists):** GitHub Action wrapper (`edgevault/load-secrets`)
— this is the "CI/CD integrations" line item, nearly free.

**Tests:** command units with injected fetch; an e2e smoke against `wrangler dev`
delivery (same pattern as existing cross-worker smokes).

---

### 1.5 Secret sharing via expiring links — M — ✅ shipped

Zero-knowledge: encrypt **client-side** in the console with a random AES-GCM key; the key
travels only in the URL fragment (`/s/:id#<key>`), which never reaches the server. Server
stores ciphertext + policy.

**Build:**
1. New DO class `ShareDurableObject` in `apps/api` (new migration tag) — a DO (not KV)
   because burn-after-read / max-view-count needs atomic decrement, and `alarm()` gives
   exact TTL cleanup. State: `{ ciphertext, iv, expiresAt, remainingViews, createdBy,
   workspaceId? }`. RPCs: `create(input)`, `consume()` (atomic decrement → ciphertext or
   410), alarm deletes storage.
2. Routes: `POST /api/v1/shares` (requireAuth; body is **ciphertext only**; TTL ≤ 7d,
   views ≤ 10) → returns share id. Public read goes through the console BFF (next step),
   not a public api route — keeps the api surface authenticated.
3. Console: "Share" action on a secret row (after the existing RBAC-gated reveal, encrypt
   in-browser, POST ciphertext) + standalone `/share` composer (paste anything). Public
   viewer route `/s/:id`: BFF resource route fetches ciphertext via `API_SERVICE`
   (internal-token guard for the unauthenticated consume path), client JS decrypts with
   the fragment key, renders once with copy button + "this link is now burned" state.
4. Audit: `share.created` / `share.viewed` via the existing `AUDIT_QUEUE`.

**Tests:** DO unit (expiry alarm, view exhaustion, atomicity under parallel consume);
round-trip encrypt/decrypt unit; BFF route test.

**Why it matters:** top-of-funnel growth loop (every shared link is a product demo) —
a proven playbook across the secrets-management category.

---

## Tier 2 — differentiating / monetizable

### 2.6 Secret syncs (push) — L *(phase it)*

Push resolved values/secrets to external stores. Flagship destination is **Cloudflare
Workers secrets** — uniquely on-brand, underserved elsewhere in the category.

**Data model (Neon):** `sync_destinations (id, workspaceId, environmentId /* DO env id */,
provider, config jsonb /* non-secret: account id, repo, script name */, credentials
/* envelope-encrypted via @edgevault/crypto */, secretFilter /* key glob */, status,
lastSyncAt, lastError, createdByUserId)`. Migration.

**Provider interface — `packages/sync-providers` (MIT):**
`{ id, validate(config), push(items: {key, value}[], config, creds): Promise<SyncResult> }`
- **cloudflare-workers**: CF API `PUT /accounts/:id/workers/scripts/:script/secrets`
  (API token cred). Ship first.
- **github-actions**: repo/org secrets — requires libsodium sealed-box; implementable with
  `@noble/curves` x25519 + `@noble/ciphers` xsalsa20poly1305 (stays in the audited-noble
  policy, no wasm).
- **vercel**: env vars API. Then **aws-secrets-manager** via `aws4fetch` (SigV4).

**Execution — `SyncWorkflow`** (Cloudflare Workflow, same pattern as
`PromotionWorkflow`): steps `load-destination` → `collect` (read items from DO; decrypt
secrets inside the api boundary — same trust zone as reveal) → `push` (provider, with
step-level retries) → `record` (status + `sync.completed|failed` audit + notify via 1.3).
**Triggers:** (a) on write — after `writeThrough`, look up destinations matching the env
(per-isolate cached) and `create()` a workflow instance, debounced per destination via a
DO-alarm coalescer (burst of 10 writes → 1 sync); (b) "Sync now" button; (c) daily
reconcile cron in `apps/api`.

**Console:** environment settings → Sync tab (add destination, test connection, status,
last error). **Phasing:** framework + cloudflare-workers (M) → github-actions (S) →
vercel/aws (S each).

**Open-core call:** framework + CF/GitHub providers MIT (adoption driver); enterprise
destinations (AWS/Azure/GCP) could be EE-gated later if desired — defer the decision.

---

### 2.7 Point-in-time environment snapshots — M

Revisions are already immutable rows; a snapshot is just a **manifest** — no content copy.

**Build (all in Workspace DO):**
1. Tables: `env_snapshots (id, environment_id, label, created_at, created_by)` +
   `env_snapshot_items (snapshot_id, config_key, revision_id, content_hash)`.
2. RPCs: `createSnapshot(envId, label, userId)` (walk current `config_items`, record each
   `published_revision_id`); `listSnapshots(envId)`; `diffSnapshot(snapshotId)` (vs
   current state — reuses 1.2's comparator shape); `restoreSnapshot(snapshotId, userId,
   { deleteExtraneous: boolean })` — per key whose hash differs, write a revision with
   `change_type: 'restore'`; optionally delete keys created since. Each restored item:
   KV write-through + broadcast + audit (reuse the `setConfig` internals — extract a
   private `applyContent()` helper so revision/broadcast/audit logic isn't duplicated).
3. Auto-snapshot hooks: before `applyPromotion` and before any restore (so restore is
   itself reversible). Retention: keep last N=50 per env, prune in the same transaction.
4. Routes + console: snapshot timeline on the environment page, "Restore to…" with a
   diff preview (1.2's table component) and a typed-confirmation modal for
   `deleteExtraneous`.

**Tests:** pool-workers: snapshot → mutate → restore → state equality incl. deletions;
restore emits per-key KV writes; auto-snapshot before promotion.

---

### 2.8 Change requests for direct edits — L (EE)

Extends the existing promotion approval gate to *any* write. Gate with
`requireEntitlement(ENTITLEMENTS.CHANGE_REQUESTS)` — `@edgevault/licensing` is a core
package reading the shared Neon `entitlements` table, so core enforces without importing
`ee/` (same pattern as the RBAC-gated secret reveal).

**Build:**
1. DO tables: `change_requests (id, environment_id, status open|approved|rejected|merged,
   title, created_by, reviewed_by, created_at, ...)` +
   `change_request_items (cr_id, config_key, change_type, proposed_content,
   base_revision_id)`.
2. Policy: `environments` gains `requires_review INTEGER` (DO migration on
   `ensureWorkspace`). When set and caller's role is below admin, `setConfig`/`delete`
   routes divert to `createChangeRequest` instead of writing.
3. RPCs: `createChangeRequest`, `listChangeRequests`, `getChangeRequest` (with
   per-item diff via `packages/diff` against current content),
   `reviewChangeRequest(id, approve|reject, userId)` — on approve, apply all items
   **atomically** with a conflict check (`base_revision_id` vs current
   `published_revision_id`; mismatch → 409 `stale`, UI offers re-diff). Apply path reuses
   2.7's `applyContent()` helper → revisions, KV write-through, broadcast, audit.
4. Notifications: `change_request.opened` / `.approved` / `.rejected` through 1.3 —
   Slack message links to the review page.
5. Console: CR list + review page (diff view, approve/reject); editor shows "your change
   will open a change request" banner when policy applies. MCP `set_config` returns
   `{ changeRequestId }` instead of the item when diverted (agents must handle it).
6. Licensing: add `CHANGE_REQUESTS` to `ENTITLEMENTS` (`packages/licensing/src/index.ts`)
   + `edge/control-plane` `planToEntitlements` mapping.

**Risk:** secret proposals sit as ciphertext in `proposed_content` (encrypt on CR
creation, same as direct writes) — reviewers see "secret changed" + hash, never plaintext.

---

### 2.9 JIT / temporary access — M (EE)

**Data model (Neon):** `access_grants (id, organizationId, workspaceId?, userId,
grantedRole, reason, status pending|active|expired|revoked|rejected, expiresAt,
requestedAt, approvedByUserId, approvedAt)`. Entitlement `JIT_ACCESS`.

**Enforcement — lazy, no daemon needed:** role resolution in
`requireWorkspaceMember` (`apps/api/src/middleware/workspace.ts:10`) becomes
`effectiveRole = max(getMemberRole(), activeGrants(userId, workspaceId, now))` — one extra
indexed Neon query; expired grants are simply ignored. A daily cron marks rows expired and
emits `access.expired` audit + Slack notice (cosmetic, not security-critical).

**Flow:** member hits "Request access" (role + duration ≤ configurable max + reason) →
`access_request.opened` notification (1.3) → admin approves in console (or directly via
the Slack link) → grant active → auto-dies at `expiresAt`. Revoke button for early kill.
Every grant lifecycle event → audit queue.

**v1 grants legacy roles** (admin/member); when 2.10 lands, grants reference custom roles.

**Tests:** middleware unit for effective-role merge incl. expiry boundary; route tests
for request/approve/revoke; entitlement-absent → 402.

---

### 2.10 Deeper RBAC — L (EE — `ADVANCED_RBAC` entitlement already reserved)

Today: org-level owner/admin/member checked inline in routes. Target: custom roles with
environment- and key-scoped permissions.

**Build:**
1. **Inventory first** (the real risk): enumerate every enforcement point — all
   `workspaces.ts` routes, secret reveal, promotion approve, API-key mint, MCP tools,
   WS upgrade. Produce a table of `(route → action)` before writing code.
2. Permission model: actions `config.read|write`, `secret.reveal`, `env.promote`,
   `env.admin`, `keys.manage`, `members.manage` × scope `{ workspaceId?, envSlugGlob?,
   keyGlob? }`. Neon: `roles (id, organizationId, name, permissions jsonb)` +
   `role_assignments (roleId, userId, workspaceId?)`.
3. `packages/rbac` (MIT core, pure): `can(permissionSet, action, resource): boolean` —
   glob matching, deny-by-default, exhaustively unit-tested. Core ships the evaluator;
   the *ability to define custom roles* is what's entitlement-gated (same open-core shape
   as licensing itself).
4. api: `requireWorkspaceMember` loads the principal's permission set (legacy role →
   synthesized permission set when no custom roles or no entitlement — **zero behavior
   change for existing users**); replace inline `c.var.role !== 'owner'` checks with
   `can()` calls per the inventory table. Cache permission sets in KV (60s TTL,
   purge on assignment change — same pattern as `AUTH_CACHE` session caching).
5. Console: role editor, member assignment, and a per-user "effective access" view —
   which seeds the Tier-3 access-tree visualization.

**Sequencing:** land the evaluator + legacy-synthesis refactor first (pure refactor,
no new tables), then custom roles. Touches every route — needs the full api test suite
green before and after, plus new authz-matrix tests.

---

### 2.11 Go + Python SDKs — M (ongoing)

Delivery-plane-only clients mirroring `packages/sdk` (`EdgeVault` class: `config`,
`value`, `flag`, `batch`, L1 TTL cache, timeout, API-key auth).

**Build:**
1. **Shared conformance fixtures first:** a JSON test-vector file in
   `packages/edge-protocol` (`conformance/vectors.json`) covering the subtle bits — flag
   boolean coercion table ('true'/'1'/'on'/'yes'/`{enabled}` etc., case-insensitivity),
   contentType→parse rules, batch null semantics. The TS SDK adopts it; Go/Python must
   pass the same vectors. This is what keeps three SDKs honest.
2. `sdks/go` (module `github.com/<org>/edgevault-go`): stdlib-only (`net/http`),
   `sync.RWMutex` L1 cache, context-aware. `sdks/python` (PyPI `edgevault`): stdlib
   `urllib`/`json` (zero-dep), optional async extra later. Both MIT, in-repo under
   `sdks/` (excluded from the pnpm workspace; own CI jobs: `go test`, `pytest`).
3. e2e smoke per SDK against `wrangler dev` delivery in CI (same cross-worker smoke
   pattern already used).

---

## Tier 3 — Vault-grade protection for the secrets we already hold

Security patterns borrowed from commercial password managers (2026-06), applied to
EdgeVault's existing config secrets — **not** a password-manager product. No structured
login items, no personal vaults, no autofill. The plays worth stealing are about *key
custody and reveal friction*: revealing a secret should cost a fresh proof of presence,
plaintext should live as briefly as possible on the client, and the most sensitive
tenants should be able to take key custody away from us entirely. All three bolt onto
the existing reveal path (`apps/api/src/routes/workspaces.ts:347`) and envelope crypto
(`packages/crypto/src/index.ts`) rather than adding product surface.

**Suggested order:** 3.2 → 3.1 → 3.3 (hygiene is an afternoon; step-up is the real
upgrade; E2E is the EE capstone and reuses 3.1's reauth flow).

---

### 3.1 Step-up reauth before secret reveal — M

The pattern: being logged in is not the same as proving presence. A reveal is rarer and
more dangerous than any other authenticated action, so it demands a fresh second factor
— and we already shipped both factors.

**Build:**
1. `apps/auth`: `POST /reauth` runs a passkey assertion (`buildAuthenticationOptions` /
   `verifyAuthentication`, `apps/auth/src/webauthn.ts:95,103`) or TOTP (`verifyUserTotp`,
   `apps/auth/src/mfa.ts:80`) against the current session → short-TTL (≤5 min)
   `reveal_token` (signed, audience `secret-reveal`), cached via the existing
   `AUTH_CACHE` idiom. Support both factors — TOTP-only users must be able to step up.
2. api: the reveal route (`workspaces.ts:347`) and the human-mode environment export
   require a valid `reveal_token`; absent/expired → 401 `reauth_required` with the
   challenge. **Machine export is exempt** — CI cannot step up; its gate remains scoped
   environment keys (`secrets:read`) + per-decrypt audit, unchanged.
3. Console: the reveal button triggers the passkey prompt only when no fresh grant
   exists; transparent within the grant window.
4. CLI human mode: on `reauth_required`, browser passkey flow via the existing login
   callback or a TOTP prompt; token cached in `~/.config/edgevault/credentials` (0600)
   with its TTL.
5. Org-level policy toggle (`require_step_up_for_reveal`, default on for new orgs);
   every reveal keeps emitting the existing audit + notify events regardless.

**Tests:** reveal-token expiry boundary unit; route test that a plain session token gets
401 `reauth_required`; CLI unit (reauth-required → prompt → retry); TOTP fallback path.

**Risks:** token replay — bind to user + session, short TTL, single audience. Don't
break MCP/agent flows silently: MCP secret reveal should surface `reauth_required` as a
structured error, not a generic 401.

---

### 3.2 Console reveal hygiene — S

The cheap, pure-client patterns — no backend change:
1. Copy-to-clipboard with best-effort 30s auto-clear and a visible "clipboard will
   clear" affordance (clearing is best-effort browser-side; present it honestly).
2. Revealed values masked by default with per-field toggles; re-mask on blur/navigate.
3. Plaintext only ever in component state — never localStorage/sessionStorage, cleared
   on unmount.

**Tests:** component tests for mask/auto-clear timers; a lint-style grep test that no
console code persists revealed values.

---

### 3.3 End-to-end encrypted workspaces (opt-in) — L (EE)

The pattern: the wrapped-vault-key model. A per-workspace symmetric key is wrapped to
each member's public key; secrets are encrypted client-side; the server stores
ciphertext it cannot read. Applied to existing workspace secrets, opt-in per workspace,
gated by a new `WORKSPACE_E2E` entitlement — the trust-model upsell for regulated
tenants. The shipped share-link crypto (`encryptShareText`/`decryptShareText`,
`packages/crypto/src/index.ts:226`) proves browser-side WebCrypto round-trips in this
codebase; this extends a known pattern, not new R&D.

**Sketch:**
1. Per-user keypair derived client-side at login from the password (Argon2id already in
   `apps/auth`); the private key never leaves the client.
2. Workspace key wrapped to each member's pubkey; membership changes re-wrap client-side
   by an admin. Envelope format gets a `v: 2` client-side variant alongside the existing
   server-side `v: 1` (`SecretEnvelope` already carries a version field).
3. Secrets encrypt in-browser before upload; configs/flags stay server-side and the
   delivery plane is untouched (it never held secrets — the existing hard rule).
4. Step-up (3.1) doubles as the unwrap ceremony UX: the same passkey prompt gates the
   client-side key unwrap.

**Documented costs (surfaced in the UI at opt-in):** no server-side reveal, so no AI
risk analysis over secret values and **no machine export of E2E secrets** — `edgevault
run` against an E2E workspace requires issuing a wrapped key to a service identity (the
CLI holds key material; ship that in the same phase or document the loss explicitly).
No break-glass. **Recovery-key escrow ships in the same phase or not at all** — an
org-held recovery keypair the workspace key is additionally wrapped to; without it, a
forgotten password loses the workspace.

**Tests:** wrap/unwrap round-trip units; membership re-wrap; v1→v2 envelope migration
on opt-in; recovery-key restore e2e.

**Risks:** key recovery is the hard part (hence escrow-or-nothing); password changes
must re-derive and re-wrap the user's private key without a decrypt-everything event.

---

## Dependency graph

```
1.2 compare ──────────────┐
1.3 webhooks/slack ──┬────┼──► 2.8 change requests
                     ├────┼──► 2.9 JIT access ◄── 2.10 RBAC (or v1 with legacy roles)
1.1 refs             │    └──► 2.7 snapshots (reuses compare UI)
1.5 share links      │
1.4 CLI ─────────────┴───────► GitHub Action (free follow-on)
2.6 syncs (independent; uses 1.3 for failure notices)
2.11 SDKs (independent)

3.2 reveal hygiene (independent, console-only)
3.1 step-up reveal ────► 3.3 E2E workspaces (the passkey prompt doubles as the unwrap UX)
1.4 CLI (shipped) ─────► 3.1 human-mode reveal adopts reveal tokens
1.5 share links (shipped) ─► 3.3 client-side crypto pattern already proven in-repo
```

## Open-core placement summary

| Feature | Placement |
|---|---|
| 1.1–1.5, 2.7, 2.11 | MIT core (`apps/*`, `packages/*`) |
| 2.6 syncs | Framework + CF/GitHub providers MIT; enterprise destinations TBD |
| 2.8 change requests | Core-enforced, `CHANGE_REQUESTS` entitlement (new) |
| 2.9 JIT access | Core-enforced, `JIT_ACCESS` entitlement (new) |
| 2.10 advanced RBAC | Core evaluator MIT; custom roles behind `ADVANCED_RBAC` (exists) |
| 3.1 step-up reveal, 3.2 reveal hygiene | MIT core |
| 3.3 E2E workspaces + recovery escrow | EE — `WORKSPACE_E2E` entitlement (new) |

New entitlements ⇒ update `packages/licensing` `ENTITLEMENTS` +
`edge/control-plane` `planToEntitlements` + pricing page when numbers are real.
