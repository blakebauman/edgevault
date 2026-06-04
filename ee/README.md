# EdgeVault Enterprise Edition (`ee/`)

Commercial-licensed features. **Not** covered by the repository's MIT license —
see [`ee/LICENSE`](./LICENSE).

## Boundary rules

- The MIT **core** (`apps/*`, `packages/*`) must **never** import from `ee/`.
  This is enforced by lint/CI in a later phase (plan §Risks #9).
- EE features are activated only when `packages/licensing` validates a signed
  license-key entitlement at runtime.

## Packages

- `sso-saml` (`@edgevault/ee-sso-saml`) — enterprise OIDC SSO (authorization-code
  + PKCE, token exchange, id-token verification). SAML 2.0 is stubbed (EE Phase B).
- `scim` (`@edgevault/ee-scim`) — SCIM 2.0 resource shapes + PATCH applier +
  ListResponse helpers.

Each is gated by a `@edgevault/licensing` entitlement (`assertSsoEntitled` /
`assertScimEntitled`). Planned: `advanced-rbac`, `audit-retention`.

Mounting these into the auth worker (routes gated by the org's verified license)
is the integration step; the packages + entitlement gates are complete and tested.
