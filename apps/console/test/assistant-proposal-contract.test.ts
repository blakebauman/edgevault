import { isAssistantProposal } from '@edgevault/edge-protocol'
import { describe, expect, it } from 'vitest'

/**
 * The guard the apply route uses to decide whether a request body is a
 * proposal at all.
 *
 * Found by probing the live route: without this check the endpoint forwarded
 * anything shaped loosely like a config write, including `itemKind: "secret"`
 * and a missing rationale — neither of which the agent's Zod schema can
 * produce. It is not a privilege boundary (the route uses the caller's own
 * session and cannot exceed the config UI), but the route's contract is
 * "applies proposals", and these cases are what makes that true.
 */

const CONFIG_CHANGE = {
  kind: 'config-change',
  environmentId: 'env_a',
  key: 'checkout.timeout',
  itemKind: 'config',
  content: '{"ms":3000}',
  rationale: 'Times out before the upstream does.',
}

const PROMOTION = {
  kind: 'promotion',
  sourceEnvironmentId: 'env_staging',
  targetEnvironmentId: 'env_prod',
  key: 'checkout.timeout',
  rationale: 'Stable for a week.',
}

describe('isAssistantProposal', () => {
  it('accepts both proposal kinds', () => {
    expect(isAssistantProposal(CONFIG_CHANGE)).toBe(true)
    expect(isAssistantProposal(PROMOTION)).toBe(true)
  })

  it('rejects a secret, which the assistant must never carry', () => {
    expect(isAssistantProposal({ ...CONFIG_CHANGE, itemKind: 'secret' })).toBe(false)
  })

  it('rejects an unknown item kind', () => {
    expect(isAssistantProposal({ ...CONFIG_CHANGE, itemKind: 'wat' })).toBe(false)
  })

  it('requires a non-empty rationale', () => {
    const { rationale: _drop, ...noRationale } = CONFIG_CHANGE
    expect(isAssistantProposal(noRationale)).toBe(false)
    expect(isAssistantProposal({ ...CONFIG_CHANGE, rationale: '' })).toBe(false)
  })

  it('requires the fields each kind actually needs', () => {
    const { environmentId: _e, ...noEnv } = CONFIG_CHANGE
    expect(isAssistantProposal(noEnv)).toBe(false)
    const { targetEnvironmentId: _t, ...noTarget } = PROMOTION
    expect(isAssistantProposal(noTarget)).toBe(false)
    expect(isAssistantProposal({ ...CONFIG_CHANGE, key: '' })).toBe(false)
  })

  it('rejects an unknown kind, so the union stays closed', () => {
    expect(isAssistantProposal({ ...CONFIG_CHANGE, kind: 'run-arbitrary-thing' })).toBe(false)
  })

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'x', 42, []]) {
      expect(isAssistantProposal(value)).toBe(false)
    }
  })
})
