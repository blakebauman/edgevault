import { redactCredentials } from './redact'
import type { EmbeddingRunner } from './types'

export async function embedTexts(
  ai: EmbeddingRunner,
  model: string,
  texts: string[],
): Promise<number[][]> {
  const result = await ai.run(model, { text: texts })
  return result.data
}

export async function embedText(
  ai: EmbeddingRunner,
  model: string,
  text: string,
): Promise<number[]> {
  const [vector] = await embedTexts(ai, model, [text])
  if (!vector) throw new Error('Embedding returned no vector')
  return vector
}

/**
 * The text we embed for a config item: key + kind + a content excerpt.
 * Credential-looking substrings are redacted before the excerpt ever reaches
 * the embedding model or Vectorize (secrets proper are excluded upstream;
 * this catches credentials living inside plain config values).
 */
export function configEmbeddingText(item: {
  key: string
  kind: string
  content: string
  contentType: string
}): string {
  const excerpt = item.content.length > 800 ? item.content.slice(0, 800) : item.content
  return `${item.kind} ${item.key} (${item.contentType})\n${redactCredentials(excerpt).text}`
}
