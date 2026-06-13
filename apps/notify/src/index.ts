import { isEmailJob, type NotifyJob, type NotifyQueueMessage } from '@edgevault/edge-protocol'
import { type EmailSender, sendEmail } from './email'
import { formatSlackMessage } from './slack'
import { buildWebhookRequest } from './webhook'

/**
 * Notification consumer: drains NOTIFY_QUEUE and delivers each job to its
 * destination — Slack incoming webhooks get Block Kit payloads, generic
 * webhooks get the raw event JSON with an HMAC signature, and invitation
 * emails go out through the `send_email` binding. Jobs are independent, so
 * messages ack/retry individually; after max_retries the queue dead-letters
 * to edgevault-notify-dlq.
 */

const DELIVERY_TIMEOUT_MS = 10_000

export async function deliver(job: NotifyJob, fetchImpl: typeof fetch = fetch): Promise<void> {
  const request =
    job.channelType === 'slack'
      ? new Request(job.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(formatSlackMessage(job.event)),
        })
      : await buildWebhookRequest(job.url, job.secret, JSON.stringify(job.event))

  const response = await fetchImpl(request, { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`delivery to channel ${job.channelId} failed: HTTP ${response.status}`)
  }
}

export default {
  async queue(batch: MessageBatch<NotifyQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (isEmailJob(message.body)) {
          // A missing binding is a config error: retry → DLQ, never a silent drop.
          const sender = (env as { SEND_EMAIL?: EmailSender }).SEND_EMAIL
          if (!sender) throw new Error('SEND_EMAIL binding missing')
          await sendEmail(sender, message.body)
        } else {
          await deliver(message.body)
        }
        message.ack()
      } catch (error) {
        const id = isEmailJob(message.body) ? message.body.to : message.body.channelId
        console.error('notification delivery failed', id, error)
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<Env, NotifyQueueMessage>
