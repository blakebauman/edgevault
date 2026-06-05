import { DurableObject } from 'cloudflare:workers'

/**
 * One Durable Object per share link — zero-knowledge expiring secret shares.
 * The browser encrypts before upload (the AES key travels only in the URL
 * fragment), so this DO stores ciphertext it can never read. A DO (not KV)
 * because burn-after-read needs an ATOMIC view-count decrement, and alarm()
 * gives exact-time cleanup of expired ciphertext.
 */

export interface ShareRecord {
  ciphertext: string
  iv: string
  expiresAt: number
  remainingViews: number
  createdBy: string
  createdAt: number
}

export type ConsumeResult =
  | { ok: true; ciphertext: string; iv: string; remainingViews: number }
  | { ok: false }

export class ShareDurableObject extends DurableObject<Env> {
  async create(input: {
    ciphertext: string
    iv: string
    expiresAt: number
    maxViews: number
    createdBy: string
  }): Promise<void> {
    const existing = await this.ctx.storage.get<ShareRecord>('share')
    if (existing) throw new Error('Share already exists')
    const record: ShareRecord = {
      ciphertext: input.ciphertext,
      iv: input.iv,
      expiresAt: input.expiresAt,
      remainingViews: input.maxViews,
      createdBy: input.createdBy,
      createdAt: Date.now(),
    }
    await this.ctx.storage.put('share', record)
    // Exact-time cleanup: expired ciphertext shouldn't linger at rest.
    await this.ctx.storage.setAlarm(input.expiresAt)
  }

  /**
   * Atomically consume one view. Returns the ciphertext or {ok:false} when the
   * share is missing, expired, or exhausted — indistinguishable on purpose.
   */
  async consume(): Promise<ConsumeResult> {
    const share = await this.ctx.storage.get<ShareRecord>('share')
    if (!share || Date.now() >= share.expiresAt) {
      await this.destroy()
      return { ok: false }
    }
    const remainingViews = share.remainingViews - 1
    if (remainingViews <= 0) {
      // Last view: burn immediately.
      await this.destroy()
    } else {
      await this.ctx.storage.put('share', { ...share, remainingViews })
    }
    return { ok: true, ciphertext: share.ciphertext, iv: share.iv, remainingViews }
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }
}
