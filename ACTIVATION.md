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

## 2. Enterprise SSO — OIDC & SAML (`ee/enterprise`, commercial)

The `edgevault-enterprise` worker is deployed (internal-only; reached via the
console's `ENTERPRISE_SERVICE` binding, authenticated by the shared
`INTERNAL_TOKEN`). There is **no platform secret to set** — SSO is configured
**per organization** at runtime, and is gated two ways:

1. **Entitlement** — the org must hold the `sso` entitlement (see §3). Without it
   every SSO endpoint returns `402 entitlement_required`.
2. **Connection** — an org admin registers the IdP via the SSO admin UI
   (`/sso-admin`, which calls `PUT /orgs/:orgId/sso/connection`): `issuer`,
   `clientId`, `clientSecret` (write-only, envelope-encrypted with the
   enterprise worker's `MASTER_KEK`), `redirectUri`, `scopes`.

- **OIDC** (Okta / Entra / Google Workspace): production-ready.
- **SAML**: the worker surface exists but **must not be enabled for real
  production orgs** until the external XML-DSig audit + assertion-replay cache
  land — see [`ee/sso-saml/SECURITY-REVIEW.md`](ee/sso-saml/SECURITY-REVIEW.md).

---

## 3. Granting entitlements (the licensing boundary)

`ee/` features read an `entitlements` row from Neon (plan + entitlement list).
A missing row = free tier. In Managed Edge this row is written automatically by
the control-plane from Stripe subscription state (§4). For sales-led enterprise
or for testing, grant it directly:

The `entitlements` column is **jsonb** (a JSON string array), so write it as
JSON — not a Postgres `ARRAY[...]`:

```sql
INSERT INTO entitlements (organization_id, plan, entitlements)
VALUES ('<org-uuid>', 'enterprise', '["sso","scim","advanced-rbac","audit-retention"]'::jsonb)
ON CONFLICT (organization_id) DO UPDATE
  SET plan = EXCLUDED.plan, entitlements = EXCLUDED.entitlements;
```

Valid entitlement strings: `sso`, `scim`, `advanced-rbac`, `audit-retention`.
Unrecognized strings are dropped at load, so a malformed row can never silently
grant an `ee/` feature.

---

## 4. Stripe billing — Managed Edge (`edge/control-plane`, proprietary)

This is the SaaS-only tier (excluded from the OSS distribution). Public URL
(Stripe needs to reach the webhook): **`billing.edgevault.io`**
(`billing-staging.edgevault.io` for staging). To activate the hosted
billing/metering plane:

1. Deploy the worker: `cd edge/control-plane && wrangler deploy` (staging:
   `wrangler deploy --env staging`). Bindings (`HYPERDRIVE` Neon +
   `AUDIT_BUCKET` R2 metering source) are pinned per environment in
   `wrangler.jsonc`.
2. Set Stripe secrets per environment (use `--name
   edgevault-control-plane-staging` with test-mode keys for staging):
   ```sh
   wrangler secret put STRIPE_SECRET_KEY      --name edgevault-control-plane
   wrangler secret put STRIPE_WEBHOOK_SECRET  --name edgevault-control-plane
   ```
3. In the Stripe Dashboard: add a webhook endpoint pointing at
   **`https://billing.edgevault.io/webhooks/stripe`**, subscribed to
   `customer.subscription.*` events. Subscriptions must carry
   `metadata.organizationId` + `metadata.plan` (set at Checkout) — events
   without them are ignored. The control-plane writes resulting plan +
   entitlements into the shared Neon `entitlements` table that `api`/`auth`/`ee`
   read (§3), and records the org → Stripe customer mapping
   (`stripe_customers`) that attributes metered usage.
4. Create **Billing Meters** whose event names match the meters the cron
   reports: `config_writes` (config + flag mutations) and `secret_operations`
   (secret lifecycle incl. reveals). The hourly cron aggregates the durable
   audit pipeline (R2 NDJSON) per fully-elapsed UTC hour and reports
   idempotently (deterministic event `identifier`s + a Neon watermark that only
   advances on full acceptance). Orgs without a `stripe_customers` row are
   skipped. Note: **edge reads and MAU are not metered** — they are not audit
   events; billing them needs a delivery-side counter (future work).

**Still to build before charging money**: **Checkout** — nothing creates Stripe
Checkout Sessions yet. Until a pricing page / console billing flow exists,
create subscriptions manually in the Dashboard with the two metadata keys above
(the webhook then fills both `entitlements` and `stripe_customers`).

See [`edge/README.md`](edge/README.md) for the control-plane details.
