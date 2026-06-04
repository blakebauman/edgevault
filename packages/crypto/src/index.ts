/**
 * Envelope encryption for customer secrets (the "vault" part), using WebCrypto
 * only (Workers-safe, Node-safe). Design:
 *
 *   master key (platform secret)            <- MASTER_KEK, 32 random bytes
 *     └─ HKDF(info = workspaceId) ──> KEK    (per-workspace key-encryption key)
 *          └─ wraps a per-secret DEK         (AES-GCM data-encryption key)
 *               └─ encrypts the plaintext    (AES-GCM)
 *
 * Rotating the master key only re-wraps DEKs (cheap), not the payloads. Secret
 * plaintext is only ever produced inside the api/DO at access time.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// TextEncoder.encode() returns Uint8Array<ArrayBufferLike>, which TS 5.7+ no
// longer accepts as a WebCrypto BufferSource; copy into an ArrayBuffer-backed array.
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(text))
}

const KEK_SALT = utf8('edgevault-kek-v1')

export interface SecretEnvelope {
  v: 1
  kekVersion: number
  ciphertext: string
  iv: string
  wrappedDek: string
  dekIv: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function randomIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(12))
}

/** Generate a base64 master key (32 bytes) for MASTER_KEK setup. */
export function generateMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
}

async function importMaster(masterKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(masterKeyB64), 'HKDF', false, ['deriveKey'])
}

async function deriveKek(master: CryptoKey, workspaceId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: KEK_SALT, info: utf8(workspaceId) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function unwrapDek(kek: CryptoKey, envelope: SecretEnvelope): Promise<CryptoKey> {
  const rawDek = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.dekIv) },
    kek,
    fromBase64(envelope.wrappedDek),
  )
  return crypto.subtle.importKey('raw', rawDek, 'AES-GCM', false, ['decrypt'])
}

export async function encryptSecret(
  masterKeyB64: string,
  workspaceId: string,
  plaintext: string,
  kekVersion = 1,
): Promise<SecretEnvelope> {
  const kek = await deriveKek(await importMaster(masterKeyB64), workspaceId)
  // AES-GCM generateKey returns a single CryptoKey; the Workers runtime types use
  // the broad overload, so narrow it explicitly.
  const dek = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
  ])) as CryptoKey

  const iv = randomIv()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, utf8(plaintext)),
  )

  const dekIv = randomIv()
  const rawDek = new Uint8Array((await crypto.subtle.exportKey('raw', dek)) as ArrayBuffer)
  const wrappedDek = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dekIv }, kek, rawDek),
  )

  return {
    v: 1,
    kekVersion,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    wrappedDek: toBase64(wrappedDek),
    dekIv: toBase64(dekIv),
  }
}

export async function decryptSecret(
  masterKeyB64: string,
  workspaceId: string,
  envelope: SecretEnvelope,
): Promise<string> {
  const kek = await deriveKek(await importMaster(masterKeyB64), workspaceId)
  const dek = await unwrapDek(kek, envelope)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    dek,
    fromBase64(envelope.ciphertext),
  )
  return decoder.decode(plaintext)
}

/** Rotate the master key by re-wrapping the DEK only (no payload re-encryption). */
export async function rewrapEnvelope(
  oldMasterKeyB64: string,
  newMasterKeyB64: string,
  workspaceId: string,
  envelope: SecretEnvelope,
  newKekVersion = envelope.kekVersion + 1,
): Promise<SecretEnvelope> {
  const oldKek = await deriveKek(await importMaster(oldMasterKeyB64), workspaceId)
  const rawDek = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.dekIv) },
    oldKek,
    fromBase64(envelope.wrappedDek),
  )
  const newKek = await deriveKek(await importMaster(newMasterKeyB64), workspaceId)
  const dekIv = randomIv()
  const wrappedDek = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dekIv }, newKek, new Uint8Array(rawDek)),
  )
  return {
    ...envelope,
    kekVersion: newKekVersion,
    wrappedDek: toBase64(wrappedDek),
    dekIv: toBase64(dekIv),
  }
}

export function isSecretEnvelope(value: unknown): value is SecretEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  )
}
