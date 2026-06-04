# EdgeVault Enterprise Edition (`ee/`)

Commercial-licensed features. **Not** covered by the repository's MIT license —
see [`ee/LICENSE`](./LICENSE).

## Boundary rules

- The MIT **core** (`apps/*`, `packages/*`) must **never** import from `ee/`.
  This is enforced by lint/CI in a later phase (plan §Risks #9).
- EE features are activated only when `packages/licensing` validates a signed
  license-key entitlement at runtime.

## Planned packages (added in Phase 9b)

- `sso-saml` — enterprise OIDC + SAML 2.0 single sign-on connections
- `scim` — SCIM 2.0 directory provisioning
- `advanced-rbac` — attribute-based access control & approval policies
- `audit-retention` — long-retention + SIEM/audit export

> Empty for now; this directory documents the boundary so the split is explicit
> from day one.
