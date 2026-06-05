import { env } from 'cloudflare:test'
import { encryptSecret } from '@edgevault/crypto'
import type { NotifyJob } from '@edgevault/edge-protocol'
import { describe, expect, it } from 'vitest'
import type { NotificationChannelRow } from '../src/database/queries'
import { dispatchNotifications, primeChannelCache } from '../src/notify'

/**
 * Dispatch is exercised against a primed channel cache and a fake queue —
 * no Postgres. Credentials are encrypted with the test MASTER_KEK so the
 * decrypt path is the real one.
 */

async function makeChannel(
  workspaceId: string,
  overrides: Partial<NotificationChannelRow> & { url?: string; secret?: string } = {},
): Promise<NotificationChannelRow> {
  const { url = 'https://example.com/hook', secret = 'whsec_test', ...rest } = overrides
  const envelope = await encryptSecret(env.MASTER_KEK, workspaceId, JSON.stringify({ url, secret }))
  return {
    id: crypto.randomUUID(),
    type: 'webhook',
    name: 'test channel',
    encryptedCredentials: JSON.stringify(envelope),
    events: null,
    enabled: true,
    ...rest,
  }
}

function fakeEnv(sent: NotifyJob[][]): Env {
  return {
    MASTER_KEK: env.MASTER_KEK,
    NOTIFY_QUEUE: {
      sendBatch: async (batch: Iterable<{ body: NotifyJob }>) => {
        sent.push([...batch].map((m) => m.body))
      },
    },
  } as unknown as Env
}

const baseEvent = {
  workspaceId: '',
  environmentId: 'env-1',
  action: 'config.updated',
  resourceType: 'config',
  key: 'k',
  userId: 'u1',
}

describe('dispatchNotifications', () => {
  it('fans out to matching channels with decrypted credentials', async () => {
    const ws = crypto.randomUUID()
    primeChannelCache(ws, [
      await makeChannel(ws),
      await makeChannel(ws, { type: 'slack', url: 'https://hooks.slack.com/services/x' }),
    ])
    const sent: NotifyJob[][] = []
    await dispatchNotifications(fakeEnv(sent), { ...baseEvent, workspaceId: ws })

    expect(sent).toHaveLength(1)
    const jobs = sent[0] as NotifyJob[]
    expect(jobs).toHaveLength(2)
    const webhook = jobs.find((j) => j.channelType === 'webhook')
    const slack = jobs.find((j) => j.channelType === 'slack')
    expect(webhook?.url).toBe('https://example.com/hook')
    expect(webhook?.secret).toBe('whsec_test')
    // Slack jobs never carry a signing secret.
    expect(slack?.url).toContain('hooks.slack.com')
    expect(slack?.secret).toBeUndefined()
    expect(webhook?.event.at).toBeGreaterThan(0)
  })

  it('respects event filters and the enabled flag', async () => {
    const ws = crypto.randomUUID()
    primeChannelCache(ws, [
      await makeChannel(ws, { events: ['secret.revealed'] }),
      await makeChannel(ws, { enabled: false }),
    ])
    const sent: NotifyJob[][] = []
    await dispatchNotifications(fakeEnv(sent), { ...baseEvent, workspaceId: ws })
    expect(sent).toHaveLength(0)

    await dispatchNotifications(fakeEnv(sent), {
      ...baseEvent,
      workspaceId: ws,
      action: 'secret.revealed',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(1)
  })

  it('skips channels with corrupt credentials and never throws', async () => {
    const ws = crypto.randomUUID()
    primeChannelCache(ws, [
      { ...(await makeChannel(ws)), encryptedCredentials: 'not-json' },
      await makeChannel(ws),
    ])
    const sent: NotifyJob[][] = []
    await dispatchNotifications(fakeEnv(sent), { ...baseEvent, workspaceId: ws })
    expect(sent[0]).toHaveLength(1)
  })

  it('does nothing for workspaces with no channels', async () => {
    const ws = crypto.randomUUID()
    primeChannelCache(ws, [])
    const sent: NotifyJob[][] = []
    await dispatchNotifications(fakeEnv(sent), { ...baseEvent, workspaceId: ws })
    expect(sent).toHaveLength(0)
  })
})
