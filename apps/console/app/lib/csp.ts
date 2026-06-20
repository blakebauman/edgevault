/**
 * Content-Security-Policy for console documents. Scripts are nonce-gated
 * (React Router streams inline hydration scripts); styles allow inline because
 * component style attributes are subject to style-src. The API origin is the
 * only cross-origin connection the browser makes — everything else goes through
 * the BFF on this origin. The assistant's Agents SDK client uses BOTH the
 * WebSocket (`wss://`) and a preliminary HTTPS fetch (`/agents/.../get-messages`
 * to load history), so connect-src must allow the matching `https://` origin
 * too — otherwise that history fetch is CSP-blocked and the assistant crashes.
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
