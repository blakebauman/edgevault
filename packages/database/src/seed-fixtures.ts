/**
 * Shared local-dev seed fixtures — the single source of truth for both seed
 * phases:
 *
 *   1. `seed.ts` (this package)  — inserts the Postgres graph (identity, orgs,
 *      members, MFA, SSO/SAML/SCIM, billing, domains, workspace metadata).
 *   2. the `/internal/seed` dev endpoint in `apps/api` — fills the Vault Durable
 *      Object + KV (environments, config/flag/secret/content items with revision
 *      history, promotions, API keys, notification channels).
 *
 * Everything is keyed by FIXED uuids so phase 2 can reference phase-1 rows and
 * re-runs are idempotent. The data models three personas spanning the product's
 * real states: a solo free org, a Pro team, and an Enterprise org with SSO.
 *
 * `dev@edgevault.test` (password `devpassword123!`) is an owner of ALL three
 * orgs, so a single local login can switch between them and see every screen
 * populated.
 */

/** The shared dev login password (also the default in `seed.ts`). */
export const SEED_PASSWORD = 'devpassword123!'
export const SEED_EMAIL = 'dev@edgevault.test'

export type ItemKind = 'config' | 'flag' | 'secret' | 'content'

export interface SeedUser {
  id: string
  email: string
  name: string
  image?: string
  /** SSO/social-only accounts have no password. */
  noPassword?: boolean
  /** Confirmed TOTP + recovery codes + a passkey are seeded for this user. */
  mfa?: boolean
  /** A linked external identity (provider account) is seeded. */
  github?: { accountId: string; username: string }
}

export interface SeedItem {
  key: string
  kind: ItemKind
  /** A known config-format; defaults sensibly per kind in phase 2. */
  contentType?: 'json' | 'yaml' | 'toml' | 'text' | 'markdown'
  /** Per-environment final content (by env slug). `staging`/`production` optional. */
  values: { development: string; staging?: string; production?: string }
  /**
   * Earlier `development` contents written BEFORE `values.development`, in order,
   * to build real revision history. Each carries the "why" recorded on its
   * revision.
   */
  history?: Array<{ content: string; summary: string }>
  /** The "why" on the final write. */
  summary?: string
}

export interface SeedApiKey {
  name: string
  /** Environment slug this key is scoped to. */
  environment: string
  scopes: Array<'read' | 'secrets:read'>
  /** A deterministic raw key so re-seeds reuse the same KV record. */
  rawKey: string
}

export interface SeedChannel {
  type: 'slack' | 'webhook'
  name: string
  url: string
  /** Restrict to these actions; omit for all events. */
  events?: string[]
}

export interface SeedWorkspace {
  id: string
  name: string
  slug: string
  aiIndexingEnabled?: boolean
  environments: Array<{ name: string; slug: string }>
  items: SeedItem[]
  /** Completed promotions to record (source/target are env slugs). */
  promotions?: Array<{ key: string; from: string; to: string }>
  apiKeys?: SeedApiKey[]
  channels?: SeedChannel[]
}

export interface SeedMember {
  userId: string
  role: 'owner' | 'admin' | 'member'
}

export interface SeedInvitation {
  email: string
  role: 'owner' | 'admin' | 'member'
  inviterId: string
}

export interface SeedSso {
  issuer: string
  clientId: string
  /** Plaintext client secret — phase 1 envelope-encrypts it. */
  clientSecret: string
  redirectUri: string
}

export interface SeedSaml {
  idpEntityId: string
  idpSsoUrl: string
  idpCertificate: string
  spEntityId: string
  acsUrl: string
}

export interface SeedCustomDomain {
  id: string
  hostname: string
  cfCustomHostnameId: string
  status: 'pending_dcv' | 'pending_ssl' | 'active' | 'failed'
  createdByUserId: string
}

export interface SeedOrg {
  id: string
  name: string
  slug: string
  plan: 'free' | 'pro' | 'team' | 'enterprise'
  requireStepUpForReveal: boolean
  requireMfa: boolean
  ssoOnly: boolean
  members: SeedMember[]
  invitations?: SeedInvitation[]
  workspaces: SeedWorkspace[]
  sso?: SeedSso
  saml?: SeedSaml
  /** Plaintext SCIM bearer token — phase 1 stores only its hash. */
  scimToken?: string
  customDomains?: SeedCustomDomain[]
  /** Stripe customer id; presence makes the org "billed". */
  stripeCustomerId?: string
}

// --- Fixed identifiers ------------------------------------------------------

const U = {
  dev: '00000000-0000-4000-8000-000000000001',
  maya: '00000000-0000-4000-8000-000000000002',
  omar: '00000000-0000-4000-8000-000000000003',
  priya: '00000000-0000-4000-8000-000000000004',
  sam: '00000000-0000-4000-8000-000000000005',
} as const

const ORG = {
  indie: '00000000-0000-4000-8001-000000000001',
  northwind: '00000000-0000-4000-8001-000000000002',
  acme: '00000000-0000-4000-8001-000000000003',
} as const

const WS = {
  sideProject: '00000000-0000-4000-8002-000000000001',
  storefront: '00000000-0000-4000-8002-000000000002',
  checkout: '00000000-0000-4000-8002-000000000003',
  platform: '00000000-0000-4000-8002-000000000004',
} as const

export const SEED_USERS: SeedUser[] = [
  { id: U.dev, email: SEED_EMAIL, name: 'Dev User' },
  { id: U.maya, email: 'maya@northwind.test', name: 'Maya Chen', mfa: true },
  {
    id: U.omar,
    email: 'omar@northwind.test',
    name: 'Omar Reyes',
    noPassword: true,
    github: { accountId: '4821007', username: 'omar-reyes' },
  },
  { id: U.priya, email: 'priya@acme.test', name: 'Priya Nair', noPassword: true },
  { id: U.sam, email: 'sam@acme.test', name: 'Sam Whitfield', noPassword: true },
]

// --- Item sets --------------------------------------------------------------

const storefrontItems: SeedItem[] = [
  {
    key: 'checkout.timeout_ms',
    kind: 'config',
    contentType: 'json',
    summary: 'Raise checkout timeout for slower 3DS flows',
    values: { development: '45000', staging: '30000', production: '30000' },
    history: [
      { content: '15000', summary: 'Initial checkout timeout' },
      { content: '30000', summary: 'Bump after payment provider latency report' },
    ],
  },
  {
    key: 'cart.max_items',
    kind: 'config',
    contentType: 'json',
    values: { development: '100', staging: '50', production: '50' },
  },
  {
    key: 'cdn.base_url',
    kind: 'config',
    contentType: 'text',
    values: {
      development: 'https://cdn.dev.northwind.test',
      staging: 'https://cdn.staging.northwind.test',
      production: 'https://cdn.northwind.test',
    },
  },
  {
    key: 'pricing.config',
    kind: 'config',
    contentType: 'yaml',
    summary: 'Free shipping threshold + currency rounding',
    values: {
      development: 'currency: USD\nfree_shipping_over: 50\ntax_inclusive: false\n',
      staging: 'currency: USD\nfree_shipping_over: 75\ntax_inclusive: false\n',
      production: 'currency: USD\nfree_shipping_over: 75\ntax_inclusive: false\n',
    },
  },
  {
    key: 'feature.express-checkout',
    kind: 'flag',
    contentType: 'json',
    summary: 'Roll express checkout to 25% in prod',
    values: {
      development: '{"enabled":true,"rollout":100}',
      staging: '{"enabled":true,"rollout":100}',
      production: '{"enabled":true,"rollout":25}',
    },
    history: [{ content: '{"enabled":false,"rollout":0}', summary: 'Create flag (off)' }],
  },
  {
    key: 'feature.new-pricing-page',
    kind: 'flag',
    contentType: 'json',
    values: {
      development: '{"enabled":true,"rollout":100}',
      staging: '{"enabled":false,"rollout":0}',
      production: '{"enabled":false,"rollout":0}',
    },
  },
  {
    key: 'STRIPE_SECRET_KEY',
    kind: 'secret',
    contentType: 'text',
    values: {
      development: 'sk_test_51NwQz2Lk9dDevExampleKey00staging00abcd',
      staging: 'sk_test_51NwQz2Lk9dStagingExampleKey00abcd1234',
      production: 'sk_live_51NwQz2Lk9dProdExampleKey00abcd567890',
    },
  },
  {
    key: 'DATABASE_URL',
    kind: 'secret',
    contentType: 'text',
    values: {
      development: 'postgres://app:devpw@db.dev.northwind.test:5432/storefront',
      staging: 'postgres://app:stgpw@db.staging.northwind.test:5432/storefront',
      production: 'postgres://app:prodpw@db.northwind.test:5432/storefront',
    },
  },
  {
    key: 'SENDGRID_API_KEY',
    kind: 'secret',
    contentType: 'text',
    values: { development: 'SG.dev_oNf3Example.transactionalEmailKey0001' },
  },
  {
    key: 'homepage-banner',
    kind: 'content',
    contentType: 'markdown',
    summary: 'Summer sale banner copy',
    values: {
      development: '# Summer Sale ☀️\nUp to **40% off** seasonal favorites. Free shipping over $50.',
      staging: '# Summer Sale ☀️\nUp to **40% off** seasonal favorites. Free shipping over $75.',
      production: '# Summer Sale ☀️\nUp to **40% off** seasonal favorites. Free shipping over $75.',
    },
  },
  {
    key: 'tos-snippet',
    kind: 'content',
    contentType: 'markdown',
    values: {
      development:
        'By completing checkout you agree to our [Terms of Service](https://northwind.test/tos).',
    },
  },
]

const checkoutServiceItems: SeedItem[] = [
  {
    key: 'retry.max_attempts',
    kind: 'config',
    contentType: 'json',
    values: { development: '5', staging: '3', production: '3' },
  },
  {
    key: 'provider.config',
    kind: 'config',
    contentType: 'toml',
    summary: 'Payment provider routing',
    values: {
      development: 'primary = "stripe"\nfallback = "adyen"\ncapture_delay_s = 0\n',
      staging: 'primary = "stripe"\nfallback = "adyen"\ncapture_delay_s = 2\n',
      production: 'primary = "stripe"\nfallback = "adyen"\ncapture_delay_s = 2\n',
    },
  },
  {
    key: 'feature.apple-pay',
    kind: 'flag',
    contentType: 'json',
    values: {
      development: '{"enabled":true,"rollout":100}',
      production: '{"enabled":true,"rollout":100}',
    },
  },
  {
    key: 'ADYEN_API_KEY',
    kind: 'secret',
    contentType: 'text',
    values: {
      development: 'AQEdhmfxLExampleDevAdyenKey0011223344',
      production: 'AQEdhmfxLExampleProdAdyenKey0099887766',
    },
  },
]

const platformItems: SeedItem[] = [
  {
    key: 'service.config',
    kind: 'config',
    contentType: 'yaml',
    summary: 'Tenant isolation + region pinning',
    values: {
      development: 'region: us-west\nmax_tenants: 1000\nisolation: shared\n',
      production: 'region: us-west\nmax_tenants: 50000\nisolation: dedicated\n',
    },
  },
  {
    key: 'rate_limit.rps',
    kind: 'config',
    contentType: 'json',
    values: { development: '1000', production: '250' },
  },
  {
    key: 'feature.audit-streaming',
    kind: 'flag',
    contentType: 'json',
    values: {
      development: '{"enabled":true,"rollout":100}',
      production: '{"enabled":true,"rollout":100}',
    },
  },
  {
    key: 'DATADOG_API_KEY',
    kind: 'secret',
    contentType: 'text',
    values: {
      development: 'dd_dev_a1b2c3ExampleObservabilityKey',
      production: 'dd_prod_z9y8x7ExampleObservabilityKey',
    },
  },
  {
    key: 'incident-runbook',
    kind: 'content',
    contentType: 'markdown',
    values: {
      development:
        '# Incident Runbook\n1. Page on-call.\n2. Check `rate_limit.rps`.\n3. Failover region if needed.',
      production:
        '# Incident Runbook\n1. Page on-call.\n2. Check `rate_limit.rps`.\n3. Failover region if needed.',
    },
  },
]

const sideProjectItems: SeedItem[] = [
  {
    key: 'app.config',
    kind: 'config',
    contentType: 'json',
    values: { development: '{"theme":"dark","betaBanner":true}' },
  },
  {
    key: 'feature.waitlist',
    kind: 'flag',
    contentType: 'json',
    values: { development: '{"enabled":true,"rollout":100}' },
  },
  {
    key: 'RESEND_API_KEY',
    kind: 'secret',
    contentType: 'text',
    values: { development: 're_dev_ExampleIndieMailKey001122' },
  },
]

const ENVIRONMENTS = [
  { name: 'Development', slug: 'development' },
  { name: 'Staging', slug: 'staging' },
  { name: 'Production', slug: 'production' },
]

// --- Personas ---------------------------------------------------------------

export const SEED_ORGS: SeedOrg[] = [
  {
    id: ORG.indie,
    name: 'Indie Labs',
    slug: 'indie-labs',
    plan: 'free',
    requireStepUpForReveal: false,
    requireMfa: false,
    ssoOnly: false,
    members: [{ userId: U.dev, role: 'owner' }],
    workspaces: [
      {
        id: WS.sideProject,
        name: 'Side Project',
        slug: 'side-project',
        environments: [{ name: 'Development', slug: 'development' }],
        items: sideProjectItems,
        apiKeys: [
          {
            name: 'Local dev',
            environment: 'development',
            scopes: ['read'],
            rawKey: 'evk_live_indie_dev_read_000000000000',
          },
        ],
      },
    ],
  },
  {
    id: ORG.northwind,
    name: 'Northwind Commerce',
    slug: 'northwind',
    plan: 'pro',
    requireStepUpForReveal: false, // relaxed locally so dev secret reveals don't demand a 2nd factor
    requireMfa: false,
    ssoOnly: false,
    stripeCustomerId: 'cus_NorthwindExample01',
    members: [
      { userId: U.dev, role: 'owner' },
      { userId: U.maya, role: 'admin' },
      { userId: U.omar, role: 'member' },
    ],
    invitations: [{ email: 'newhire@northwind.test', role: 'member', inviterId: U.dev }],
    workspaces: [
      {
        id: WS.storefront,
        name: 'Storefront',
        slug: 'storefront',
        environments: ENVIRONMENTS,
        items: storefrontItems,
        promotions: [
          { key: 'checkout.timeout_ms', from: 'development', to: 'staging' },
          { key: 'feature.express-checkout', from: 'staging', to: 'production' },
        ],
        apiKeys: [
          {
            name: 'Production edge (read)',
            environment: 'production',
            scopes: ['read'],
            rawKey: 'evk_live_northwind_prod_read_0000000001',
          },
          {
            name: 'CI export (secrets)',
            environment: 'staging',
            scopes: ['read', 'secrets:read'],
            rawKey: 'evk_live_northwind_stg_secrets_00000002',
          },
        ],
        channels: [
          {
            type: 'slack',
            name: '#deploys',
            url: 'https://hooks.slack.com/services/T000EXAMPLE/B000EXAMPLE/devSeedSlackToken',
          },
          {
            type: 'webhook',
            name: 'Ops webhook',
            url: 'https://ops.northwind.test/hooks/edgevault',
            events: ['config.updated', 'config.promoted'],
          },
        ],
      },
      {
        id: WS.checkout,
        name: 'Checkout Service',
        slug: 'checkout-service',
        environments: ENVIRONMENTS,
        items: checkoutServiceItems,
        apiKeys: [
          {
            name: 'Production edge (read)',
            environment: 'production',
            scopes: ['read'],
            rawKey: 'evk_live_checkout_prod_read_00000000003',
          },
        ],
      },
    ],
  },
  {
    id: ORG.acme,
    name: 'Acme Corp',
    slug: 'acme',
    plan: 'enterprise',
    requireStepUpForReveal: true,
    requireMfa: true,
    ssoOnly: true,
    stripeCustomerId: 'cus_AcmeExample01',
    members: [
      { userId: U.dev, role: 'owner' },
      { userId: U.priya, role: 'admin' },
      { userId: U.sam, role: 'member' },
    ],
    sso: {
      issuer: 'https://acme.okta.com',
      clientId: '0oa1ExampleAcmeOidcClient',
      clientSecret: 'oidc-client-secret-acme-dev-example-0011',
      redirectUri: 'https://auth.edgevault.io/sso/oidc/callback',
    },
    saml: {
      idpEntityId: 'https://acme.okta.com/saml/metadata',
      idpSsoUrl: 'https://acme.okta.com/app/acme/sso/saml',
      idpCertificate: 'MIIDExampleAcmeIdPSigningCertificateBase64ABCDEF0123456789abcdef==',
      spEntityId: 'https://auth.edgevault.io/saml/acme',
      acsUrl: 'https://auth.edgevault.io/saml/acme/acs',
    },
    scimToken: 'evscim_AcmeExampleScimBearerToken00112233',
    customDomains: [
      {
        id: '00000000-0000-4000-8003-000000000001',
        hostname: 'config.acme.example',
        cfCustomHostnameId: 'cf_hostname_acme_example_0001',
        status: 'active',
        createdByUserId: U.dev,
      },
    ],
    workspaces: [
      {
        id: WS.platform,
        name: 'Platform',
        slug: 'platform',
        environments: ENVIRONMENTS,
        items: platformItems,
        promotions: [{ key: 'rate_limit.rps', from: 'development', to: 'production' }],
        apiKeys: [
          {
            name: 'Edge (read)',
            environment: 'production',
            scopes: ['read'],
            rawKey: 'evk_live_acme_prod_read_000000000000004',
          },
        ],
        channels: [
          {
            type: 'webhook',
            name: 'SIEM forwarder',
            url: 'https://siem.acme.example/ingest/edgevault',
          },
        ],
      },
    ],
  },
]
