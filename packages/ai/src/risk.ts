import { redactCredentials } from './redact'
import type { TextRunner } from './types'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskScore {
  level: RiskLevel
  requiresApproval: boolean
  reasons: string[]
  source: 'ai' | 'heuristic'
}

export interface RiskInput {
  key: string
  kind: string
  targetEnvironmentSlug: string
  oldContent: string | null
  newContent: string
}

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b
}

function extractRollout(content: string | null): number | null {
  if (!content) return null
  const match = content.match(/"?rollout"?\s*[:=]\s*(\d+)/i)
  return match ? Number(match[1]) : null
}

/** Deterministic guardrails, applied regardless of (and as a floor under) the AI verdict. */
export function heuristicRisk(input: RiskInput): RiskScore {
  const reasons: string[] = []
  const isProd = /prod/i.test(input.targetEnvironmentSlug)
  if (isProd) reasons.push('targets a production environment')
  if (input.kind === 'secret') reasons.push('changes a secret')

  const oldRollout = extractRollout(input.oldContent)
  const newRollout = extractRollout(input.newContent)
  if (oldRollout !== null && newRollout !== null && newRollout - oldRollout >= 50) {
    reasons.push(`rollout jumps ${oldRollout}% -> ${newRollout}%`)
  }

  const level: RiskLevel =
    isProd || reasons.length >= 2 ? 'high' : reasons.length === 1 ? 'medium' : 'low'
  return { level, requiresApproval: level === 'high', reasons, source: 'heuristic' }
}

function parseRisk(response: string | undefined): { level: RiskLevel; reasons: string[] } | null {
  if (!response) return null
  const match = response.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { level?: string; reasons?: unknown }
    const level = (['low', 'medium', 'high'] as const).find((l) => l === obj.level)
    if (!level) return null
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === 'string')
      : []
    return { level, reasons }
  } catch {
    return null
  }
}

/**
 * Score the risk of a config change with an LLM, floored by deterministic
 * heuristics. The model can only RAISE risk above the heuristic floor, never
 * lower it; any model/parse failure falls back to the heuristic verdict.
 */
export async function scoreConfigRisk(
  ai: TextRunner,
  model: string,
  input: RiskInput,
): Promise<RiskScore> {
  const floor = heuristicRisk(input)
  try {
    // Values are redacted before they reach the model: a credential pasted
    // into a plain config must not transit LLM inference verbatim.
    const prompt = `You are a configuration-change risk reviewer. Respond with strict JSON {"level":"low|medium|high","reasons":["..."]}.
Key: ${input.key} (${input.kind})
Target environment: ${input.targetEnvironmentSlug}
Old value: ${input.oldContent ? redactCredentials(input.oldContent).text : '(none)'}
New value: ${redactCredentials(input.newContent).text}`
    const result = await ai.run(model, {
      messages: [
        { role: 'system', content: 'Score the risk of a configuration change. JSON only.' },
        { role: 'user', content: prompt },
      ],
    })
    const parsed = parseRisk(result.response)
    if (!parsed) return floor

    const level = maxLevel(floor.level, parsed.level)
    return {
      level,
      requiresApproval: level === 'high' || floor.requiresApproval,
      reasons: [...floor.reasons, ...parsed.reasons],
      source: 'ai',
    }
  } catch {
    return floor
  }
}
