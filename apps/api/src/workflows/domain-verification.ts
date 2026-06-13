import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { customDomains } from '@edgevault/database/schema'
import { customDomainCacheKey } from '@edgevault/edge-protocol'
import { eq } from 'drizzle-orm'
import {
  deleteCustomHostname,
  extractDcvRecords,
  getCustomHostname,
  mapCfToDomainStatus,
  saasConfig,
} from '../custom-hostnames'

/**
 * Durable DCV polling for a custom delivery domain (ROADMAP 2.12). CF has no
 * status webhook, so after `POST /:orgId/domains` creates the custom hostname
 * this polls every 2 minutes (~2h cap):
 *   - active  → write the `domain:{hostname}` → orgId pin delivery enforces
 *   - CF terminal (deleted/moved/blocked) or timeout → mark the row `failed`
 *     (kept so the console shows why) and clean up the CF hostname + pin
 *   - row deleted mid-poll → stop quietly
 */

export interface DomainVerificationParams {
  domainId: string
  organizationId: string
  hostname: string
  cfHostnameId: string
}

const MAX_POLLS = 60 // ~2 hours at 2-minute intervals
const POLL_INTERVAL = '2 minutes'

type PollOutcome = 'gone' | 'retry' | 'pending_dcv' | 'pending_ssl' | 'active' | 'failed'

export class DomainVerificationWorkflow extends WorkflowEntrypoint<Env, DomainVerificationParams> {
  override async run(event: WorkflowEvent<DomainVerificationParams>, step: WorkflowStep) {
    const { domainId, organizationId, hostname, cfHostnameId } = event.payload

    for (let i = 0; i < MAX_POLLS; i++) {
      await step.sleep(`poll-wait-${i}`, POLL_INTERVAL)

      const outcome = await step.do(`check-status-${i}`, async (): Promise<PollOutcome> => {
        const config = saasConfig(this.env)
        if (!config) return 'gone'
        const { createDatabase } = await import('@edgevault/database')
        const conn = createDatabase(this.env.HYPERDRIVE.connectionString)
        try {
          // The domain may have been deleted (or replaced) while we slept.
          const [row] = await conn.database
            .select()
            .from(customDomains)
            .where(eq(customDomains.id, domainId))
          if (!row || row.cfCustomHostnameId !== cfHostnameId) return 'gone'

          const cf = await getCustomHostname(config, cfHostnameId)
          if (!cf.ok) return 'retry' // transient CF API trouble; next poll retries

          const status = mapCfToDomainStatus(cf.result.status, cf.result.ssl?.status)
          if (status !== row.status) {
            await conn.database
              .update(customDomains)
              .set({
                status,
                updatedAt: new Date(),
                dcvRecords: extractDcvRecords(cf.result),
                failureReason: status === 'failed' ? cf.result.status : null,
              })
              .where(eq(customDomains.id, domainId))
          }
          return status
        } finally {
          await conn.close()
        }
      })

      if (outcome === 'gone') return { hostname, outcome: 'removed' }
      if (outcome === 'active') {
        await step.do('write-domain-pin', async () => {
          await this.env.ENVIRONMENT_API_KEYS.put(customDomainCacheKey(hostname), organizationId)
        })
        return { hostname, outcome: 'active' }
      }
      if (outcome === 'failed') {
        await step.do('cleanup-failed', () => this.cleanup(cfHostnameId, hostname))
        return { hostname, outcome: 'failed' }
      }
      // retry / pending_dcv / pending_ssl → keep polling
    }

    // DCV never completed. Mark failed and reclaim the CF hostname — the user
    // deletes the row and re-adds once their DNS is actually ready.
    await step.do('timeout-failed', async () => {
      const { createDatabase } = await import('@edgevault/database')
      const conn = createDatabase(this.env.HYPERDRIVE.connectionString)
      try {
        await conn.database
          .update(customDomains)
          .set({ status: 'failed', failureReason: 'timeout', updatedAt: new Date() })
          .where(eq(customDomains.id, domainId))
      } finally {
        await conn.close()
      }
      await this.cleanup(cfHostnameId, hostname)
    })
    return { hostname, outcome: 'timeout' }
  }

  private async cleanup(cfHostnameId: string, hostname: string): Promise<void> {
    const config = saasConfig(this.env)
    if (config) await deleteCustomHostname(config, cfHostnameId).catch(() => {})
    await this.env.ENVIRONMENT_API_KEYS.delete(customDomainCacheKey(hostname)).catch(() => {})
  }
}
