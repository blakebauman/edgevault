# Managed Edge control plane (`edge/`) — proprietary

Proprietary code that powers **Managed Edge**, EdgeVault's hosted SaaS. This
directory is **excluded from the open-source distribution** and is not licensed
for redistribution.

## Boundary rules

- Neither the MIT **core** (`apps/*`, `packages/*`) nor the **EE** (`ee/*`) may
  import from `edge/`.
- All billing / Stripe / metering / provisioning logic lives here and **nowhere
  else** — the OSS distribution ships without it.

## Planned worker + packages (added in Phase 9c)

- `control-plane` — a separate Worker: Stripe Billing Meters (Checkout, Customer
  Portal, webhooks → entitlements), tenant provisioning/onboarding, and the
  Analytics-Engine → Stripe usage-metering cron (idempotent, watermarked).

It writes tenant **entitlements** into the shared Neon database that the OSS
`api`/`auth` workers read, so Managed Edge subscriptions and self-host license
keys converge on one entitlement model.

> Empty for now; this directory documents the boundary explicitly.
