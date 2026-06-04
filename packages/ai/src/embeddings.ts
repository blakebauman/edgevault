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

/** The text we embed for a config item: key + kind + a content excerpt. */
export function configEmbeddingText(item: {
  key: string
  kind: string
  content: string
  contentType: string
}): string {
  const excerpt = item.content.length > 800 ? item.content.slice(0, 800) : item.content
  return `${item.kind} ${item.key} (${item.contentType})\n${excerpt}`
}
