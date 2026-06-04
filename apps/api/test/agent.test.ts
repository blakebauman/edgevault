import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { EdgeVaultAgent } from '../src/agent/agent'
import type { WorkspaceDurableObject } from '../src/durable-objects/workspace'

function agent(name: string) {
  return env.AGENT.get(env.AGENT.idFromName(name)) as DurableObjectStub<EdgeVaultAgent>
}
function workspace(name: string) {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName(name),
  ) as DurableObjectStub<WorkspaceDurableObject>
}

// The fallback path waits for the (unavailable) live AI call to reject first,
// which can take a few seconds in the test runtime — allow ample time.
const SLOW = 20_000

describe('EdgeVaultAgent', () => {
  it('grounds answers in workspace activity and persists chat turns', {
    timeout: SLOW,
  }, async () => {
    // Seed some activity in the workspace.
    const ws = workspace('agent-ws')
    const e = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'alice' })
    await ws.setConfig({
      environmentId: e.id,
      key: 'checkout.enabled',
      content: 'true',
      contentType: 'text',
      userId: 'alice',
    })

    const a = agent('agent-ws')
    const result = await a.ask({ workspaceId: 'agent-ws', question: 'what changed recently?' })

    // No live AI in tests -> deterministic fallback grounded in the activity log.
    expect(result.source).toBe('fallback')
    expect(result.groundedOnEvents).toBeGreaterThan(0)
    expect(result.answer).toContain('checkout.enabled')

    const history = await a.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.question).toBe('what changed recently?')
  })

  it('handles an empty workspace gracefully', { timeout: SLOW }, async () => {
    const result = await agent('agent-empty').ask({
      workspaceId: 'agent-empty',
      question: 'anything?',
    })
    expect(result.answer).toMatch(/no recent activity/i)
  })
})
