import {
  Button,
  CardTable,
  Checkbox,
  ErrorNote,
  Field,
  Input,
  Td,
  Th,
  TokenBox,
  TokenValue,
} from '@edgevault/ui'
import { Form, redirect, useNavigation } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { KeyExpiry } from '../components/items'
import { handleItemAction, loadApiKeys } from '../lib/items.server'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/environment.keys'

/**
 * Environment API keys: env-scoped and shown exactly once at mint. `read` serves
 * configs and flags; `secrets:read` additionally lets `edgevault run` inject
 * secrets (admin-only to mint). Keys live here rather than under a single type
 * because they govern access across every kind in the environment.
 */

export function meta() {
  return [{ title: 'API keys · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const base = `/${params.workspaceId}`
  const apiKeys = await loadApiKeys(context.cloudflare.env, token, base, params.envId)
  return { apiKeys }
}

export function action({ request, params, context }: Route.ActionArgs) {
  return handleItemAction(request, context.cloudflare.env, params.workspaceId, params.envId)
}

export default function KeysSection({ loaderData, actionData }: Route.ComponentProps) {
  const { apiKeys } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const pendingIntent = navigation.formData?.get('intent')
  const error = actionData && 'error' in actionData ? (actionData.error as string) : null
  const mintedKey =
    actionData && 'mintedKey' in actionData ? (actionData.mintedKey as string) : null

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}

      <h2>Environment API keys</h2>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Keys are environment-scoped and shown once. <code className="font-mono">read</code> serves
        configs and flags; <code className="font-mono">secrets:read</code> additionally lets{' '}
        <code className="font-mono">edgevault run</code> inject secrets (admin-only to mint).
      </p>

      {mintedKey && (
        <TokenBox
          className="mt-6"
          note={
            <>
              API key — copy it now, it won't be shown again. Use it as{' '}
              <code>EDGEVAULT_API_KEY</code> (CLI) or <code>apiKey</code> (SDK).
            </>
          }
        >
          <TokenValue>{mintedKey}</TokenValue>
          <CopyButton value={mintedKey} label="Copy key" clearAfterMs={30_000} />
        </TokenBox>
      )}

      <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
        <input type="hidden" name="intent" value="mint-key" />
        <Field label="Key name">
          <Input type="text" name="name" required placeholder="e.g. production server" />
        </Field>
        <fieldset className="grid gap-1.5 rounded-sm border border-input p-3">
          <legend className="text-muted-foreground">Scopes</legend>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders a native input inside the label */}
          <label className="flex items-center gap-2 font-mono text-xs">
            <Checkbox name="scopes" value="read" defaultChecked /> read
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders a native input inside the label */}
          <label className="flex items-center gap-2 font-mono text-xs">
            <Checkbox name="scopes" value="secrets:read" /> secrets:read
          </label>
        </fieldset>
        <Field label="Expires after (days, optional)">
          <Input type="number" name="expiresInDays" min={1} max={365} placeholder="never" />
        </Field>
        <Field label="Allowed IPs / CIDRs (optional, comma-separated)">
          <Input type="text" name="allowedCidrs" placeholder="203.0.113.0/24, 2001:db8::/32" />
        </Field>
        <Button
          type="submit"
          loading={busy && pendingIntent === 'mint-key'}
          disabled={busy}
          className="self-start"
        >
          Mint API key
        </Button>
      </Form>

      {apiKeys.length > 0 && (
        <CardTable label="Active API keys" className="mt-6">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Prefix</Th>
              <Th>Scopes</Th>
              <Th>Expires</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <Td>{k.name}</Td>
                <Td label="Prefix">
                  <span className="font-mono text-xs">{k.prefix}…</span>
                </Td>
                <Td label="Scopes" className="font-mono text-xs">
                  {k.scopes.join(', ')}
                  {k.allowedCidrs.length > 0 && (
                    <span className="text-muted-foreground"> · ip-restricted</span>
                  )}
                </Td>
                <Td label="Expires" className="text-muted-foreground">
                  <KeyExpiry expiresAt={k.expiresAt} />
                </Td>
                <Td>
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke-key" />
                    <input type="hidden" name="keyId" value={k.id} />
                    <Button type="submit" variant="secondary" size="compact" disabled={busy}>
                      Revoke
                    </Button>
                  </Form>
                </Td>
              </tr>
            ))}
          </tbody>
        </CardTable>
      )}
    </>
  )
}
