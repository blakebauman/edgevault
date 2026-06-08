import type { NotificationEvent, NotifyJob } from '@edgevault/edge-protocol'
import { describe, expect, it, vi } from 'vitest'
import worker, { deliver } from '../src/index'
import { formatSlackMessage } from '../src/slack'
import { signPayload } from '../src/webhook'

const event: NotificationEvent = {
  at: 1700000000000,
  workspaceId: 'ws-1',
  environmentId: 'env-prod',
  action: 'promotion.awaiting_approval',
  resourceType: 'promotion',
  key: 'db.timeout',
  userId: 'user-1',
  detail: { riskLevel: 'high', promotionId: 'promo-1' },
}

function job(overrides: Partial<NotifyJob> = {}): NotifyJob {
  return {
    channelId: 'ch-1',
    channelType: 'webhook',
    url: 'https://example.com/hook',
    secret: 'test-secret',
    event,
    ...overrides,
  }
}

describe('webhook signing', () => {
  it('produces a stable HMAC-SHA256 over timestamp.body', async () => {
    // Vector computed independently with node:crypto.
    const signature = await signPayload('test-secret', '1700000000000', '{"hello":"world"}')
    expect(signature).toBe(
      'sha256=5245fbdbc6c0d4400f88a82ade278c6bd968b9fb69a4ef3477f86b8f9241abab',
    )
  })

  it('changes with secret, timestamp, and body', async () => {
    const base = await signPayload('s1', 't1', 'b1')
    expect(await signPayload('s2', 't1', 'b1')).not.toBe(base)
    expect(await signPayload('s1', 't2', 'b1')).not.toBe(base)
    expect(await signPayload('s1', 't1', 'b2')).not.toBe(base)
  })
})

describe('slack formatting', () => {
  it('formats known actions with context facts', () => {
    const message = formatSlackMessage(event)
    expect(message.text).toContain('needs approval')
    expect(message.text).toContain('db.timeout')
    expect(message.blocks).toHaveLength(2)
    const context = JSON.stringify(message.blocks[1])
    expect(context).toContain('ws-1')
    expect(context).toContain('riskLevel')
    expect(context).toContain('high')
  })

  it('falls back gracefully for unknown actions', () => {
    const message = formatSlackMessage({ ...event, action: 'something.new' })
    expect(message.text).toContain('something.new')
  })

  it('has a friendly test message', () => {
    const message = formatSlackMessage({ ...event, action: 'test' })
    expect(message.text).toContain('test notification')
  })
})

describe('deliver', () => {
  it('POSTs signed JSON to generic webhooks', async () => {
    let captured: Request | undefined
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      captured = input as Request
      return new Response('ok')
    })
    await deliver(job(), fetchImpl as unknown as typeof fetch)

    expect(captured?.url).toBe('https://example.com/hook')
    expect(captured?.method).toBe('POST')
    const timestamp = captured?.headers.get('x-edgevault-timestamp')
    const signature = captured?.headers.get('x-edgevault-signature')
    expect(timestamp).toBeTruthy()
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    const body = await captured?.text()
    expect(body).toBe(JSON.stringify(event))
    // Signature verifies against the delivered timestamp + body.
    expect(await signPayload('test-secret', timestamp as string, body as string)).toBe(signature)
  })

  it('POSTs Block Kit payloads to Slack channels without a signature', async () => {
    let captured: Request | undefined
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      captured = input as Request
      return new Response('ok')
    })
    await deliver(
      job({ channelType: 'slack', url: 'https://hooks.slack.com/services/x', secret: undefined }),
      fetchImpl as unknown as typeof fetch,
    )
    expect(captured?.headers.get('x-edgevault-signature')).toBeNull()
    const body = JSON.parse((await captured?.text()) as string)
    expect(body.blocks).toBeTruthy()
    expect(body.text).toContain('needs approval')
  })

  it('throws on non-2xx so the queue retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(deliver(job(), fetchImpl as unknown as typeof fetch)).rejects.toThrow('HTTP 500')
  })
})

describe('queue handler', () => {
  it('acks successful deliveries and retries failures independently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (input as Request).url
        return url.includes('bad') ? new Response('err', { status: 502 }) : new Response('ok')
      }),
    )
    try {
      const good = { body: job(), ack: vi.fn(), retry: vi.fn() }
      const bad = {
        body: job({ channelId: 'ch-2', url: 'https://example.com/bad' }),
        ack: vi.fn(),
        retry: vi.fn(),
      }
      const batch = { messages: [good, bad] } as unknown as MessageBatch<NotifyJob>
      await worker.queue(batch, {} as Env)

      expect(good.ack).toHaveBeenCalled()
      expect(good.retry).not.toHaveBeenCalled()
      expect(bad.retry).toHaveBeenCalled()
      expect(bad.ack).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes invitation emails through SEND_EMAIL, dead-letters without it', async () => {
    const emailJob = {
      kind: 'invitation-email' as const,
      to: 'newcomer@example.com',
      organizationName: 'Acme',
      inviterName: 'Ada',
      role: 'member',
      acceptUrl: 'https://app.test/invite/x',
      expiresAt: Date.now() + 1000,
    }
    const send = vi.fn(async () => ({ messageId: 'm1' }))
    const sent = { body: emailJob, ack: vi.fn(), retry: vi.fn() }
    const batch = { messages: [sent] } as unknown as MessageBatch<NotifyJob>
    await worker.queue(batch, { SEND_EMAIL: { send } } as unknown as Env)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'newcomer@example.com' }))
    expect(sent.ack).toHaveBeenCalled()

    // Missing binding = config error → retry (→ DLQ), never a silent drop.
    const dropped = { body: emailJob, ack: vi.fn(), retry: vi.fn() }
    const batch2 = { messages: [dropped] } as unknown as MessageBatch<NotifyJob>
    await worker.queue(batch2, {} as Env)
    expect(dropped.retry).toHaveBeenCalled()
    expect(dropped.ack).not.toHaveBeenCalled()
  })
})
