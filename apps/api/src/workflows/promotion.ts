import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { scoreConfigRisk } from '@edgevault/ai'
import { aiRunner, textModel } from '../ai'
import type { ConfigItem, Promotion } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'
import { publishTargets } from '../edge-cache'
import { dispatchNotifications } from '../notify'

export interface PromotionParams {
  workspaceId: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  key: string
  requestedBy: string
}

export interface ApprovalEvent {
  approved: boolean
  by?: string
}

/**
 * Durable config promotion (dev→staging→prod) with an approval gate. The
 * promotion is snapshotted up front, paused for human approval when the target
 * looks like production, then applied, propagated to the edge cache, and
 * verified — surviving restarts at every step.
 *
 * The AI risk-scan (Phase 6) will replace the heuristic below; the audit fan-out
 * to Queues/R2 (Phase 8) will replace the DO activity log.
 */
export class PromotionWorkflow extends WorkflowEntrypoint<Env, PromotionParams> {
  override async run(event: WorkflowEvent<PromotionParams>, step: WorkflowStep) {
    const params = event.payload
    const workspace = () =>
      this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(params.workspaceId),
      ) as DurableObjectStub<VaultDurableObject>

    // 1. Snapshot the source and record a pending promotion. The instance id
    // travels with the row so the console can approve/reject a parked one.
    const promotion = await step.do('begin', async (): Promise<Promotion> => {
      const created = await workspace().createPendingPromotion({
        sourceEnvironmentId: params.sourceEnvironmentId,
        targetEnvironmentId: params.targetEnvironmentId,
        key: params.key,
        userId: params.requestedBy,
        workflowInstanceId: event.instanceId,
      })
      return { ...created }
    })

    // 2. Risk scan: AI scoring with a deterministic heuristic floor + fallback.
    const risk = await step.do('risk-scan', async () => {
      const target = await workspace().getEnvironment(params.targetEnvironmentId)
      const source = await workspace().getConfig(params.sourceEnvironmentId, params.key)
      const existing = await workspace().getConfig(params.targetEnvironmentId, params.key)
      const score = await scoreConfigRisk(aiRunner(this.env), textModel(this.env), {
        key: params.key,
        kind: source?.kind ?? 'config',
        targetEnvironmentSlug: target?.slug ?? '',
        oldContent: existing?.content ?? null,
        newContent: source?.content ?? '',
      })
      // Stamp the verdict on the promotion row — the console shows it at the gate.
      await workspace().setPromotionRisk(promotion.id, score.level)
      return {
        requiresApproval: score.requiresApproval,
        level: score.level,
        reasons: score.reasons,
      }
    })

    // 3. Approval gate.
    if (risk.requiresApproval) {
      // Tell the humans a promotion is parked at the gate (Slack/webhooks).
      await step.do('notify-approval', async () => {
        await dispatchNotifications(this.env, {
          workspaceId: params.workspaceId,
          environmentId: params.targetEnvironmentId,
          action: 'promotion.awaiting_approval',
          resourceType: 'promotion',
          key: params.key,
          userId: params.requestedBy,
          detail: {
            riskLevel: risk.level,
            promotionId: promotion.id,
            workflowInstanceId: event.instanceId,
          },
        })
      })
      const approval = await step.waitForEvent<ApprovalEvent>('await-approval', {
        type: 'promotion-approval',
        timeout: '7 days',
      })
      if (!approval.payload.approved) {
        await step.do('reject', () => workspace().failPromotion(promotion.id))
        return { status: 'rejected' as const, promotionId: promotion.id }
      }
    }

    // 4. Apply the approved (snapshotted) revision to the target environment.
    const target = await step.do('apply', async (): Promise<ConfigItem> => {
      const applied = await workspace().applyPromotion(promotion.id, params.requestedBy)
      return { ...applied }
    })

    // 5. Propagate the resolved value to the edge cache (KV) — the promoted
    // item plus anything that references it, with ${...} expanded.
    await step.do('propagate', async () => {
      const { targets } = await workspace().collectPublishTargets(
        params.targetEnvironmentId,
        params.key,
      )
      await publishTargets(this.env, params.workspaceId, targets)
    })

    // 6. Verify the read-back matches what we promoted.
    const verified = await step.do('verify', async () => {
      const current = await workspace().getConfig(params.targetEnvironmentId, params.key)
      return current?.content === target.content
    })
    if (!verified) {
      await step.do('mark-failed', () => workspace().failPromotion(promotion.id))
      return {
        status: 'failed-verification' as const,
        promotionId: promotion.id,
      }
    }

    return {
      status: 'completed' as const,
      promotionId: promotion.id,
      version: target.version,
    }
  }
}
