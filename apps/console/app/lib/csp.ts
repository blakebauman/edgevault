/**
 * Content-Security-Policy for console documents. Scripts are nonce-gated
 * (React Router streams inline hydration scripts); styles allow inline because
 * component style attributes are subject to style-src. The websocket origin is
 * the only cross-origin connection the browser makes — everything else goes
 * through the BFF on this origin.
 */
export function buildCsp(nonce: string, apiWsBase?: string): string {
  const connect = apiWsBase ? `'self' ${apiWsBase}` : "'self'"
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
