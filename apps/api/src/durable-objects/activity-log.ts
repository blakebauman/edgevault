import type { ActivityEntry } from './types'

type ActivityRow = {
  id: string
  action: string
  resource_type: string
  resource_id: string
  user_id: string | null
  changes: string | null
  created_at: number
}

function toEntry(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    userId: row.user_id,
    changes: row.changes,
    createdAt: row.created_at,
  }
}

/** Append-only audit trail for the workspace (hot/recent; cold store is R2). */
export class ActivityLogger {
  constructor(private readonly sql: SqlStorage) {}

  log(input: {
    action: string
    resourceType: string
    resourceId: string
    userId?: string | null
    changes?: unknown
  }): void {
    this.sql.exec(
      `INSERT INTO activity_log (id, action, resource_type, resource_id, user_id, changes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.action,
      input.resourceType,
      input.resourceId,
      input.userId ?? null,
      input.changes === undefined ? null : JSON.stringify(input.changes),
    )
  }

  list(limit = 50, offset = 0): ActivityEntry[] {
    return this.sql
      .exec<ActivityRow>(
        `SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        limit,
        offset,
      )
      .toArray()
      .map(toEntry)
  }
}
