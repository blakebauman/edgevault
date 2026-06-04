import { decryptSecret, encryptSecret, isSecretEnvelope } from '@edgevault/crypto'
import type { ConfigItem, ConfigKind } from './durable-objects/types'

/**
 * Secret handling for the api layer: customer secrets are envelope-encrypted
 * here before being stored in the workspace DO (which only ever sees ciphertext),
 * and decrypted only on an authorized reveal. The edge cache and search index
 * never receive secrets at all.
 */

export async function prepareSecretContent(
  env: Env,
  workspaceId: string,
  kind: ConfigKind | undefined,
  content: string,
): Promise<{ content: string; isEncrypted: boolean }> {
  if (kind !== 'secret') return { content, isEncrypted: false }
  const envelope = await encryptSecret(env.MASTER_KEK, workspaceId, content)
  return { content: JSON.stringify(envelope), isEncrypted: true }
}

export async function revealSecret(
  env: Env,
  workspaceId: string,
  item: ConfigItem,
): Promise<string | null> {
  if (item.kind !== 'secret' || !item.isEncrypted) return item.content || null
  let parsed: unknown
  try {
    parsed = JSON.parse(item.content)
  } catch {
    return null
  }
  if (!isSecretEnvelope(parsed)) return null
  return decryptSecret(env.MASTER_KEK, workspaceId, parsed)
}
