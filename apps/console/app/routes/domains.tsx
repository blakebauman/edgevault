import {
  Button,
  CardTable,
  Chip,
  type ChipVariant,
  ErrorNote,
  Field,
  Input,
  StatusNote,
  Td,
  Th,
  TwoStepConfirm,
} from '@edgevault/ui'
import { useEffect } from 'react'
import { Form, redirect, useRevalidator } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { LocalTime } from '../components/local-time'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/domains'

/**
 * Custom delivery domains: serve configs from the org's own hostname instead
 * of cdn.edgevault.io. The api provisions the hostname through Cloudflare for
 * SaaS; this page surfaces the CNAME + DCV records the org's DNS needs and the
 * provisioning status. A GET lazily refreshes pending statuses from Cloudflare,
 * so "check status" is just a refetch. The api enforces RBAC; this is the UI.
 */

type DomainStatus = 'pending_dcv' | 'pending_ssl' | 'active' | 'failed'

interface DcvRecords {
  ownershipVerification: { type: string; name: string; value: string } | null
  ownershipVerificationHttp: { http_url: string; http_body: string } | null
  sslValidationRecords: Array<{
    txt_name?: string
    txt_value?: string
    http_url?: string
    http_body?: string
  }> | null
}

interface Domain {
  id: string
  hostname: string
  status: DomainStatus
  failureReason: string | null
  dcvRecords: DcvRecords | null
  createdAt: string
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Custom domains · EdgeVault' }]
}

const STATUS_CHIP: Record<DomainStatus, { variant: ChipVariant; label: string }> = {
  pending_dcv: { variant: 'warn', label: 'Verifying DNS' },
  pending_ssl: { variant: 'warn', label: 'Issuing certificate' },
  active: { variant: 'ok', label: 'Active' },
  failed: { variant: 'danger', label: 'Failed' },
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}` }

  const orgsRes = await env.API_SERVICE.fetch('https://api/api/v1/organizations', { headers })
  if (orgsRes.status === 401) throw redirect('/login')
  const organizations = orgsRes.ok
    ? (
        (await orgsRes.json()) as {
          organizations: Array<{ id: string; name: string; role: string }>
        }
      ).organizations
    : []
  const org = organizations.find((o) => o.id === params.orgId)
  if (!org) throw redirect('/')

  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/domains`,
    { headers },
  )
  if (res.status === 403) throw redirect('/')
  // 404 means the deployment has no Cloudflare for SaaS credentials configured
  // (CF_ZONE_ID / CF_SAAS_API_TOKEN) — a quiet capability gap, not an error.
  const enabled = res.status !== 404
  const body = res.ok
    ? ((await res.json()) as { domains: Domain[]; cnameTarget: string })
    : { domains: [] as Domain[], cnameTarget: '' }

  return { org, role: org.role, enabled, domains: body.domains, cnameTarget: body.cnameTarget }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const base = `https://api/api/v1/organizations/${params.orgId}/domains`
  const form = await request.formData()
  const intent = String(form.get('intent'))

  if (intent === 'add') {
    const hostname = String(form.get('hostname') ?? '').trim()
    const res = await env.API_SERVICE.fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname }),
    })
    if (res.ok) return { added: hostname }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'adding the domain') }
  }

  if (intent === 'remove') {
    const domainId = String(form.get('domainId'))
    const res = await env.API_SERVICE.fetch(`${base}/${domainId}`, { method: 'DELETE', headers })
    if (res.ok) return { removed: true as const }
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail
    return { error: detail ?? friendlyError(res.status, 'removing the domain') }
  }

  return { error: 'Unknown action' }
}

export default function Domains({ loaderData, actionData }: Route.ComponentProps) {
  const { org, role, enabled, domains, cnameTarget } = loaderData
  const isAdmin = role === 'owner' || role === 'admin'
  const revalidator = useRevalidator()

  // Pending statuses resolve on Cloudflare's side; the GET refreshes them, so
  // poll while anything is in flight and stop the moment nothing is.
  const hasPending = domains.some((d) => d.status === 'pending_dcv' || d.status === 'pending_ssl')
  useEffect(() => {
    if (!hasPending) return
    const id = setInterval(() => revalidator.revalidate(), 30_000)
    return () => clearInterval(id)
  }, [hasPending, revalidator])

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Custom domains</p>
          <h1>{org.name}</h1>
        </div>
        {enabled && domains.length > 0 && (
          <Button type="button" variant="secondary" onClick={() => revalidator.revalidate()}>
            {revalidator.state === 'loading' ? 'Checking…' : 'Check status'}
          </Button>
        )}
      </header>

      {!enabled ? (
        <>
          <p className="lede">Custom domains aren't enabled on this deployment.</p>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Self-hosting? Set <code className="font-mono">CF_ZONE_ID</code> and{' '}
            <code className="font-mono">CF_SAAS_API_TOKEN</code> on the api worker to provision
            hostnames through Cloudflare for SaaS — this page lights up once they're configured.
          </p>
        </>
      ) : (
        <>
          <p className="lede">
            Serve configs from your own hostname. CNAME it to{' '}
            <code className="font-mono">{cnameTarget}</code>.
          </p>

          {actionData && 'error' in actionData && <ErrorNote>{actionData.error}</ErrorNote>}
          {actionData && 'added' in actionData && (
            <StatusNote>
              {actionData.added} added — create the DNS records below to activate it.
            </StatusNote>
          )}
          {actionData && 'removed' in actionData && <StatusNote>Domain removed.</StatusNote>}

          {domains.length === 0 ? (
            <p className="text-muted-foreground">No custom domains yet.</p>
          ) : (
            <CardTable label="Custom domains">
              <thead>
                <tr>
                  <Th>Hostname</Th>
                  <Th>Status</Th>
                  <Th>Added</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => {
                  const chip = STATUS_CHIP[d.status]
                  return (
                    <DomainRows
                      key={d.id}
                      domain={d}
                      chip={chip}
                      cnameTarget={cnameTarget}
                      canRemove={isAdmin}
                      orgName={org.name}
                    />
                  )
                })}
              </tbody>
            </CardTable>
          )}

          {isAdmin && (
            <>
              <h2>Add a domain</h2>
              <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                Add the hostname here first, then create the DNS records it asks for. Certificates
                issue automatically once DNS verifies — usually within a few minutes.
              </p>
              <Form method="post" className="mt-4 flex max-w-md flex-wrap items-end gap-3">
                <input type="hidden" name="intent" value="add" />
                <Field label="Hostname" className="flex-1">
                  <Input type="text" name="hostname" required placeholder="config.example.com" />
                </Field>
                <Button type="submit">Add domain</Button>
              </Form>
            </>
          )}

          {!isAdmin && (
            <p className="mt-2 text-sm text-muted-foreground">
              Only owners and admins manage custom domains.
            </p>
          )}
        </>
      )}
    </section>
  )
}

/** A domain's table row, plus a full-width setup row while it isn't active. */
function DomainRows({
  domain: d,
  chip,
  cnameTarget,
  canRemove,
  orgName,
}: {
  domain: Domain
  chip: { variant: ChipVariant; label: string }
  cnameTarget: string
  canRemove: boolean
  orgName: string
}) {
  return (
    <>
      <tr>
        <Td>
          <span className="font-mono text-foreground">{d.hostname}</span>
        </Td>
        <Td label="Status">
          <Chip variant={chip.variant}>{chip.label}</Chip>
          {d.status === 'failed' && d.failureReason && (
            <span className="text-xs text-muted-foreground"> · {d.failureReason}</span>
          )}
        </Td>
        <Td label="Added" className="text-muted-foreground">
          <LocalTime epoch={Date.parse(d.createdAt)} />
        </Td>
        <Td>
          {canRemove && (
            <TwoStepConfirm
              trigger="Remove"
              note={`Remove ${d.hostname} from ${orgName}? Traffic to it stops resolving.`}
            >
              {(close) => (
                <Form method="post" onSubmit={close}>
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="domainId" value={d.id} />
                  <Button type="submit" variant="danger" size="compact">
                    Confirm remove
                  </Button>
                </Form>
              )}
            </TwoStepConfirm>
          )}
        </Td>
      </tr>
      {d.status !== 'active' && (
        <tr>
          <Td colSpan={4}>
            <div className="flex flex-col gap-2 py-1">
              <p className="m-0 text-xs text-muted-foreground">
                Create these DNS records at your provider — status refreshes automatically.
              </p>
              <SetupRecord kind="cname" name={d.hostname} value={cnameTarget} />
              {d.dcvRecords?.ownershipVerification && (
                <SetupRecord
                  kind={d.dcvRecords.ownershipVerification.type}
                  name={d.dcvRecords.ownershipVerification.name}
                  value={d.dcvRecords.ownershipVerification.value}
                />
              )}
              {d.dcvRecords?.ownershipVerificationHttp && (
                <SetupRecord
                  kind="http"
                  name={d.dcvRecords.ownershipVerificationHttp.http_url}
                  value={d.dcvRecords.ownershipVerificationHttp.http_body}
                />
              )}
              {d.dcvRecords?.sslValidationRecords?.map((rec, i) => (
                <span key={`${rec.txt_name ?? rec.http_url ?? i}`} className="contents">
                  {rec.txt_name && rec.txt_value && (
                    <SetupRecord kind="txt" name={rec.txt_name} value={rec.txt_value} />
                  )}
                  {rec.http_url && rec.http_body && (
                    <SetupRecord kind="http" name={rec.http_url} value={rec.http_body} />
                  )}
                </span>
              ))}
            </div>
          </Td>
        </tr>
      )}
    </>
  )
}

/** One DNS/HTTP validation record: name → value, each copyable, all mono. */
function SetupRecord({ kind, name, value }: { kind: string; name: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 shrink-0 font-mono text-xs uppercase tracking-widest text-muted-foreground">
        {kind}
      </span>
      <code className="break-all rounded-sm bg-muted px-2 py-1 font-mono text-xs">{name}</code>
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
      <code className="break-all rounded-sm bg-muted px-2 py-1 font-mono text-xs">{value}</code>
      <CopyButton value={value} label="Copy" />
    </div>
  )
}
