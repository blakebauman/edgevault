# Managed Edge control plane (`edge/`) — proprietary

Proprietary code that powers **Managed Edge**, EdgeVault's hosted SaaS. This
directory is **excluded from the open-source distribution** and is not licensed
for redistribution.

## Boundary rules

- Neither the MIT **core** (`apps/*`, `packages/*`) nor the **EE** (`ee/*`) may
  import from `edge/`.
- All billing / Stripe / metering / provisioning logic lives here and **nowhere
  else** — the OSS distribution ships without it.

## `control-plane` (`@edgevault/edge-control-plane`)

A separate, proprietary Worker:

- **Stripe webhooks** — WebCrypto HMAC signature verification (no Stripe SDK),
  subscription events → tenant **entitlement** updates (`planToEntitlements`).
- **Usage metering** — a cron that aggregates billable counters off the durable
  audit pipeline (Queues→R2 SQL, not sampled Analytics) and reports to Stripe
  Billing Meters (`reportMeterEvents`).

It writes entitlements into the shared Neon database that the OSS `api`/`auth`
read, so Managed Edge subscriptions and self-host license keys converge on one
entitlement model (`@edgevault/licensing`).

Live Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) + the Neon
entitlements table + the metering source are wired at deploy; the signature
verification + plan mapping + reporting logic are complete and tested.
