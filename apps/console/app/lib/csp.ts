/**
 * Content-Security-Policy for console documents. Scripts are nonce-gated
 * (React Router streams inline hydration scripts); styles allow inline because
 * component style attributes are subject to style-src. The API origin is the
 * only cross-origin connection the browser makes — everything else goes through
 * the BFF on this origin. The assistant's Agents SDK client needs BOTH schemes
 * of that origin: the chat itself rides the WebSocket (`wss://`), but the SDK
 * still reaches for `https://` on its own (stream resumption after an
 * interrupted turn), and a CSP-blocked fetch there surfaces as the assistant
 * crashing rather than as a console warning. History is *not* one of those
 * fetches — `getInitialMessages: null` in global-assistant.tsx turns off the
 * default `/agents/.../get-messages` call, because the api sends no CORS
 * headers; history re-syncs over the socket instead.
 */
export function buildCsp(nonce: string, apiWsBase?: string): string {
  const apiOrigins = apiWsBase ? [apiWsBase, apiWsBase.replace(/^ws(s?):\/\//, 'http$1://')] : []
  const connect = ["'self'", ...apiOrigins].join(' ')
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}
