import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/billing'

/**
 * Org billing & plan. Owner/admins upgrade to a self-serve plan via Stripe
 * Checkout (hosted page) or open the Stripe Billing Portal to manage/cancel.
 * The BFF enforces the owner/admin check, then asks the Managed-Edge control
 * plane (BILLING_SERVICE, INTERNAL_TOKEN-authed) to mint the hosted-page URL.
 * Without the binding (OSS self-host) the page explains license keys instead.
 * Entitlements update asynchronously via the Stripe webhook after Checkout.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Billing · EdgeVault' }]
}

interface Org {
  id: string
  name: string
  slug: string
  role: string
}

interface BillingStatus {
  plan: string
  entitlements: string[]
  hasCustomer: boolean
  plans: { pro: boolean; team: boolean }
}

const ADMIN_ROLES = new Set(['owner', 'admin'])

async function requireOrgAdmin(token: string, orgId: string, env: Env): Promise<Org> {
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401 || res.status === 403) throw redirect('/login')
  const organizations = res.ok ? ((await res.json()) as { organizations: Org[] }).organizations : []
  const org = organizations.find((o) => o.id === orgId)
  if (!org) throw redirect('/')
  return org
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const org = await requireOrgAdmin(token, params.orgId, env)

  const isAdmin = ADMIN_ROLES.has(org.role)
  const billingAvailable = Boolean(env.BILLING_SERVICE)
  const checkoutResult = new URL(request.url).searchParams.get('checkout')

  let status: BillingStatus | null = null
  if (isAdmin && env.BILLING_SERVICE) {
    const res = await env.BILLING_SERVICE.fetch(
      `https://billing/billing/status?organizationId=${params.orgId}`,
      { headers: { 'x-internal-token': env.INTERNAL_TOKEN } },
    )
    if (res.ok) status = (await res.json()) as BillingStatus
  }

  return { org, isAdmin, billingAvailable, status, checkoutResult }
}

function messageForStatus(status: number): string {
  if (status === 501) return 'This plan is not purchasable yet. Please contact support.'
  if (status === 404) return 'No billing account exists for this organization yet.'
  if (status === 503) return 'Billing is not activated on this deployment.'
  return 'Something went wrong talking to billing. Please try again.'
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const org = await requireOrgAdmin(token, params.orgId, env)
  if (!ADMIN_ROLES.has(org.role)) return { error: 'Only owners or admins can manage billing.' }
  if (!env.BILLING_SERVICE) return { error: 'Billing is not available on this deployment.' }

  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  const origin = new URL(request.url).origin
  const billingPage = `${origin}/orgs/${params.orgId}/billing`

  if (intent === 'checkout') {
    const res = await env.BILLING_SERVICE.fetch('https://billing/billing/checkout', {
      method: 'POST',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: params.orgId,
        plan: String(form.get('plan') ?? ''),
        successUrl: `${billingPage}?checkout=success`,
        cancelUrl: `${billingPage}?checkout=cancelled`,
      }),
    })
    if (!res.ok) return { error: messageForStatus(res.status) }
    const { url } = (await res.json()) as { url: string }
    throw redirect(url)
  }

  if (intent === 'portal') {
    const res = await env.BILLING_SERVICE.fetch('https://billing/billing/portal', {
      method: 'POST',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: params.orgId, returnUrl: billingPage }),
    })
    if (!res.ok) return { error: messageForStatus(res.status) }
    const { url } = (await res.json()) as { url: string }
    throw redirect(url)
  }

  return { error: 'Unknown action.' }
}

const PLAN_COPY: Record<string, { title: string; blurb: string }> = {
  pro: { title: 'Pro', blurb: 'For small teams: higher limits and email support.' },
  team: {
    title: 'Team',
    blurb: 'For growing teams: extended audit retention and priority support.',
  },
}

export default function Billing({ loaderData, actionData }: Route.ComponentProps) {
  const { org, isAdmin, billingAvailable, status, checkoutResult } = loaderData
  const error = actionData && 'error' in actionData ? actionData.error : null

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Billing &amp; plan</p>
            <h1>{org.name}</h1>
          </div>
          <Link to="/" className="secondary button">
            ← All workspaces
          </Link>
        </header>

        {!isAdmin && (
          <p className="error-text">Only organization owners or admins can manage billing.</p>
        )}
        {isAdmin && !billingAvailable && (
          <p className="muted">
            This deployment is self-hosted: plans are activated with license keys instead of
            billing. Contact your EdgeVault vendor for an enterprise license.
          </p>
        )}

        {isAdmin && billingAvailable && (
          <>
            {checkoutResult === 'success' && (
              <p className="muted">
                Payment received — thank you! Your plan updates within a few seconds (we confirm the
                subscription with Stripe in the background). Refresh to see it.
              </p>
            )}
            {checkoutResult === 'cancelled' && <p className="muted">Checkout cancelled.</p>}
            {error && <p className="error-text">{error}</p>}

            <p className="lede">
              Current plan: <strong>{status?.plan ?? 'free'}</strong>
            </p>

            <div className="row" style={{ gap: '1.5rem', alignItems: 'stretch' }}>
              {(['pro', 'team'] as const).map((plan) => (
                <div className="token-box" key={plan} style={{ flex: 1 }}>
                  <p className="token-note">{PLAN_COPY[plan]?.title}</p>
                  <p className="muted">{PLAN_COPY[plan]?.blurb}</p>
                  {status?.plan === plan ? (
                    <p className="muted">This is your current plan.</p>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="checkout" />
                      <input type="hidden" name="plan" value={plan} />
                      <button type="submit" disabled={!status?.plans[plan]}>
                        {status?.plans[plan]
                          ? `Upgrade to ${PLAN_COPY[plan]?.title}`
                          : 'Coming soon'}
                      </button>
                    </Form>
                  )}
                </div>
              ))}
              <div className="token-box" style={{ flex: 1 }}>
                <p className="token-note">Enterprise</p>
                <p className="muted">
                  SSO/SAML, SCIM, advanced RBAC, audit retention. Sales-led —{' '}
                  <a href="mailto:sales@edgevault.io">contact sales</a>.
                </p>
              </div>
            </div>

            {status?.hasCustomer && (
              <Form method="post" style={{ marginTop: '1.5rem' }}>
                <input type="hidden" name="intent" value="portal" />
                <button type="submit" className="secondary">
                  Manage billing (invoices, payment method, cancel)
                </button>
              </Form>
            )}
          </>
        )}
      </section>
    </main>
  )
}
