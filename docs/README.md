# EdgeVault documentation

Edge-native configuration, feature flags, and secrets on Cloudflare.

## By audience

**Using EdgeVault (app developers)**
- [Quickstart](./quickstart.md) — create a config and read it from the edge in
  under five minutes.
- [Architecture](./architecture.md) — how the pieces fit and where your data
  lives.

**Operating EdgeVault (self-hosters)**
- [Deployment](../DEPLOYMENT.md) — bring-your-own-Cloudflare-account install,
  required products, secrets, and the operational runbook.
- [Activation](../ACTIVATION.md) — turn on optional providers (social OAuth,
  enterprise SSO) and Managed Edge billing.

**Contributing & security**
- [Contributing](../CONTRIBUTING.md) — dev setup, conventions, DCO sign-off.
- [Security policy & threat model](../SECURITY.md) — reporting, crypto, residual
  risks.
- [SAML security review](../ee/sso-saml/SECURITY-REVIEW.md) — why SAML is gated.

## Licensing at a glance

| Tier | Path | License |
|---|---|---|
| Core | `apps/*`, `packages/*` | MIT |
| Enterprise | `ee/*` | Commercial ([`ee/LICENSE`](../ee/LICENSE)) |
| Managed Edge | `edge/*` | Proprietary (SaaS-only) |

The MIT core never imports `ee/` or `edge/`; a CI check (`pnpm boundary`)
enforces that boundary on every change.
