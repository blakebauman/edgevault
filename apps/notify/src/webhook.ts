/**
 * Generic signed-webhook delivery. Receivers verify authenticity by recomputing
 * HMAC-SHA256 over `${timestamp}.${body}` with their channel's signing secret
 * and comparing against `x-edgevault-signature`; checking `x-edgevault-timestamp`
 * freshness (e.g. ±5 minutes) prevents replay.
 */

const encoder = new TextEncoder()

export async function signPayload(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

export async function buildWebhookRequest(
  url: string,
  secret: string | undefined,
  body: string,
): Promise<Request> {
  const timestamp = String(Date.now())
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'edgevault-notify/1.0',
    'x-edgevault-timestamp': timestamp,
  }
  if (secret) headers['x-edgevault-signature'] = await signPayload(secret, timestamp, body)
  return new Request(url, { method: 'POST', headers, body })
}
