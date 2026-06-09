# Activating optional providers

The platform deploys and runs without any of these. Each is opt-in and needs
credentials you own. Set secrets per environment with
`wrangler secret put <NAME> --name <worker>` (worker names are `edgevault-<app>`
for production and `edgevault-<app>-staging` for staging). Redirect/callback URLs
below use `app.edgevault.io` (production) — swap to `app-staging.edgevault.io`
for staging.

---

## 1. Social OAuth — GitHub & Google (core, MIT)

Sign-in with GitHub/Google. **Optional:** an empty client id disables that
provider (the button just won't function); nothing else is affected.

The flow is `console → AUTH_SERVICE`; the console supplies its own callback as
the redirect URI: **`https://app.edgevault.io/oauth/<provider>/callback`**.

### GitHub
1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
   (register one app per environment).
   - Homepage URL: `https://app.edgevault.io`
   - Authorization callback URL: `https://app.edgevault.io/oauth/github/callback`
   - (staging) a second app with `…app-staging.edgevault.io/oauth/github/callback`
2. Set the secrets on the **auth** worker:
   ```sh
   wrangler secret put GITHUB_CLIENT_ID     --name edgevault-auth   # + edgevault-auth-staging
   wrangler secret put GITHUB_CLIENT_SECRET  --name edgevault-auth
   ```

### Google
1. Google Cloud Console → APIs & Services → **Credentials → Create OAuth client
   ID → Web application**.
   - Authorized redirect URI: `https://app.edgevault.io/oauth/google/callback`
   (+ the `app-staging…` URI for staging).
2. Set the secrets on the **auth** worker:
   ```sh
   wrangler secret put GOOGLE_CLIENT_ID     --name edgevault-auth
   wrangler secret put GOOGLE_CLIENT_SECRET  --name edgevault-auth
   ```

No redeploy is required — secrets take effect on the next request. Verify by
visiting `/login` and completing a provider round-trip.

---

## 2. Enterprise SSO — OIDC & SAML (core, `apps/auth`)

Enterprise SSO is a **core feature** — no entitlement, no separate worker. The
OIDC/SAML connection + login-verification routes live in the auth worker
(`apps/auth/src/sso.ts`), reached by the console BFF via the `AUTH_SERVICE`
binding and authenticated by the shared `INTERNAL_TOKEN`. There is **no platform
secret to set** — SSO is configured **per organization** at runtime:

- **Connection** — an org admin registers the IdP via the SSO admin UI
  (`/sso-admin`, which calls `PUT /orgs/:orgId/sso/connection`): `issuer`,
  `clientId`, `clientSecret` (write-only, envelope-encrypted with the auth
  worker's `MASTER_KEK`), `redirectUri`, `scopes`.

- **OIDC** (Okta / Entra / Google Workspace): production-ready.
- **SAML**: the surface exists but **must not be enabled for real production
  orgs** until the external XML-DSig audit + assertion-replay cache land — see
  [`packages/sso-saml/SECURITY-REVIEW.md`](packages/sso-saml/SECURITY-REVIEW.md).

SCIM provisioning is likewise core: an org admin generates a bearer token at
`/scim` (api: `POST /api/v1/organizations/:orgId/scim-token`), and the IdP calls
the public SCIM surface at `https://api.edgevault.io/scim/v2/{org}/Users`.

---

## 3. Stripe billing — Managed Edge (`edge/control-plane`, proprietary)

This is the SaaS-only tier (excluded from the OSS distribution). Public URL
(Stripe needs to reach the webhook): **`billing.edgevault.io`**
(`billing-staging.edgevault.io` for staging). To activate the hosted
billing/metering plane:

1. Deploy the worker: `cd edge/control-plane && wrangler deploy` (staging:
   `wrangler deploy --env staging`). Bindings (`HYPERDRIVE` Neon +
   `AUDIT_BUCKET` R2 metering source) are pinned per environment in
   `wrangler.jsonc`.
2. Set secrets per environment (use `--name edgevault-control-plane-staging`
   with test-mode keys for staging). `INTERNAL_TOKEN` must equal the value on
   auth/api/console — it admits the console BFF to the `/billing/*` Checkout
   surface:
   ```sh
   wrangler secret put STRIPE_SECRET_KEY      --name edgevault-control-plane
   wrangler secret put STRIPE_WEBHOOK_SECRET  --name edgevault-control-plane
   wrangler secret put INTERNAL_TOKEN         --name edgevault-control-plane
   ```
3. In the Stripe Dashboard: add a webhook endpoint pointing at
   **`https://billing.edgevault.io/webhooks/stripe`**, subscribed to
   `customer.subscription.*` events. Subscriptions must carry
   `metadata.organizationId` + `metadata.plan` — the console's Checkout flow
   sets both automatically; only manually-created subscriptions need them added
   by hand. The control-plane records the resulting plan + org → Stripe customer
   mapping on the shared Neon `stripe_customers` row (the plan is a billing label
   only — it gates no features), which also attributes metered usage.
4. Create recurring **prices** for the self-serve plans and put their ids in the
   control-plane's `wrangler.jsonc` vars (`STRIPE_PRICE_PRO`,
   `STRIPE_PRICE_TEAM`; empty = that plan shows "Coming soon"), then redeploy.
   The console's **`/orgs/:orgId/billing`** page (owner/admin-only) then offers
   Stripe Checkout upgrades and — once a customer exists — the Stripe Billing
   Portal (invoices, payment method, cancel). `enterprise` is deliberately
   sales-led: set it on the org's `stripe_customers.plan` directly, never via
   Checkout. Self-host deployments without the console's `BILLING_SERVICE`
   binding show the self-hosted note instead.
5. Create **Billing Meters** whose event names match the four the cron reports:
   - `config_writes` — config + flag mutations.
   - `secret_operations` — secret lifecycle incl. reveals.
   - `edge_reads` — config/flag reads served by the delivery worker. Reads are
     **pre-aggregated per isolate** in the delivery worker and flushed (off the
     response path) onto the same audit queue as count-carrying events, so they
     ride the same hourly pipeline without one event per read.
   - `mau` — monthly active users (distinct users with an active session in a
     UTC month, per org). Reported **once per fully-elapsed month** with a
     per-month idempotent `identifier`, computed directly from Neon (not the
     audit pipeline, since MAU is a distinct count).

   `config_writes`/`secret_operations`/`edge_reads` aggregate the durable audit
   pipeline (R2 NDJSON) per fully-elapsed UTC hour; all reports are idempotent
   (deterministic event `identifier`s + per-source Neon watermarks that only
   advance on full acceptance). Orgs without a `stripe_customers` row are skipped.

See [`edge/README.md`](edge/README.md) for the control-plane details.
