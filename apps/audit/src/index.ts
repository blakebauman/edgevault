import type { AuditEvent } from '@edgevault/edge-protocol'

/**
 * Audit consumer: drains the AUDIT_QUEUE in batches and archives each batch to
 * R2 as newline-delimited JSON, partitioned by date. This is the durable, cold,
 * infinite-retention store; a Pipeline + R2 Data Catalog (Iceberg) + R2 SQL make
 * it queryable. The DO's activity_log remains the hot, recent trail.
 */

export function buildObjectKey(now: Date, suffix: string): string {
  const day = now.toISOString().slice(0, 10) // YYYY-MM-DD
  return `audit/${day}/${now.getTime()}-${suffix}.ndjson`
}

export function serializeBatch(events: AuditEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

export default {
  async queue(batch: MessageBatch<AuditEvent>, env: Env): Promise<void> {
    if (batch.messages.length === 0) return
    const events = batch.messages.map((message) => message.body)
    const key = buildObjectKey(new Date(), crypto.randomUUID())
    try {
      await env.AUDIT_BUCKET.put(key, serializeBatch(events), {
        httpMetadata: { contentType: 'application/x-ndjson' },
      })
      batch.ackAll()
    } catch {
      // Leave messages un-acked so the queue retries the batch.
      batch.retryAll()
    }
  },
} satisfies ExportedHandler<Env, AuditEvent>
