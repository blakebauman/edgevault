# Managed Edge control plane (`edge/`) — proprietary

Proprietary code that powers **Managed Edge**, EdgeVault's hosted SaaS. This
directory is **excluded from the open-source distribution** and is not licensed
for redistribution.

## Boundary rules

- The MIT **core** (`apps/*`, `packages/*`) must never import from `edge/`.
- All billing / Stripe / metering / provisioning logic lives here and **nowhere
  else** — the OSS distribution ships without it. There is no feature-gating:
  every product feature is core; this directory only handles *billing*.

## `control-plane` (`@edgevault/edge-control-plane`)

A separate, proprietary Worker:

- **Stripe webhooks** — WebCrypto HMAC signature verification (no Stripe SDK),
  subscription events → the org's **billing plan** tier (`planUpdateFromEvent`).
- **Usage metering** — a cron that aggregates billable counters off the durable
  audit pipeline (Queues→R2 SQL, not sampled Analytics) and reports to Stripe
  Billing Meters (`reportMeterEvents`).

It records the org's plan + Stripe customer mapping on the shared Neon
`stripe_customers` row. The plan is a coarse billing label only — it gates no
features (the platform monetizes via usage metering + self-serve tiers, not by
withholding capabilities).

Live Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) + the metering
source are wired at deploy; the signature verification + plan mapping + reporting
logic are complete and tested.
