/**
 * Minimal, dependency-free byte encodings (base64, base64url, hex) built on the
 * standard `btoa`/`atob` available in Workers and Node. We own this trivial,
 * low-risk code rather than taking a dependency for it. (Cryptographic
 * primitives — Argon2id, SHA-256 — stay on audited libraries; encoding does not
 * warrant the same caution.)
 */

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeBase64urlNoPadding(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeBase64url(encoded: string): Uint8Array {
  let normalized = encoded.replaceAll('-', '+').replaceAll('_', '/')
  while (normalized.length % 4 !== 0) normalized += '='
  return decodeBase64(normalized)
}

export function encodeHexLowerCase(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function decodeHex(encoded: string): Uint8Array {
  if (encoded.length % 2 !== 0) throw new Error('Invalid hex string length')
  const bytes = new Uint8Array(encoded.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(encoded.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
