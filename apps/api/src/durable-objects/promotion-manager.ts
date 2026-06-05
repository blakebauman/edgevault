import type { Promotion, PromotionStatus } from './types'

type PromotionRow = {
  id: string
  source_environment_id: string
  target_environment_id: string
  config_key: string
  source_revision_id: string
  target_revision_id: string | null
  status: string
  created_at: number
  completed_at: number | null
  created_by: string
  workflow_instance_id: string | null
  risk_level: string | null
}

function toPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    sourceEnvironmentId: row.source_environment_id,
    targetEnvironmentId: row.target_environment_id,
    key: row.config_key,
    sourceRevisionId: row.source_revision_id,
    targetRevisionId: row.target_revision_id,
    status: row.status as PromotionStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    workflowInstanceId: row.workflow_instance_id,
    riskLevel: row.risk_level,
  }
}

/** Records of config promotions between environments (the copy is done by the DO). */
export class PromotionManager {
  constructor(private readonly sql: SqlStorage) {}

  create(input: {
    sourceEnvironmentId: string
    targetEnvironmentId: string
    key: string
    sourceRevisionId: string
    createdBy: string
    workflowInstanceId?: string | null
  }): Promotion {
    const id = crypto.randomUUID()
    this.sql.exec(
      `INSERT INTO config_promotions
        (id, source_environment_id, target_environment_id, config_key, source_revision_id, status, created_by, workflow_instance_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      input.sourceEnvironmentId,
      input.targetEnvironmentId,
      input.key,
      input.sourceRevisionId,
      input.createdBy,
      input.workflowInstanceId ?? null,
    )
    return this.get(id) as Promotion
  }

  /** Record the workflow's risk-scan verdict so the console can show it. */
  setRisk(id: string, riskLevel: string): void {
    this.sql.exec(`UPDATE config_promotions SET risk_level = ? WHERE id = ?`, riskLevel, id)
  }

  markCompleted(id: string, targetRevisionId: string): void {
    this.sql.exec(
      `UPDATE config_promotions
       SET status = 'completed', target_revision_id = ?, completed_at = unixepoch()
       WHERE id = ?`,
      targetRevisionId,
      id,
    )
  }

  markFailed(id: string): void {
    this.sql.exec(
      `UPDATE config_promotions SET status = 'failed', completed_at = unixepoch() WHERE id = ?`,
      id,
    )
  }

  get(id: string): Promotion | null {
    const row = this.sql
      .exec<PromotionRow>(`SELECT * FROM config_promotions WHERE id = ?`, id)
      .toArray()[0]
    return row ? toPromotion(row) : null
  }

  list(limit = 50, offset = 0): Promotion[] {
    return this.sql
      .exec<PromotionRow>(
        `SELECT * FROM config_promotions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        limit,
        offset,
      )
      .toArray()
      .map(toPromotion)
  }
}
