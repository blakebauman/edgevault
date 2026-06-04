import { hashContent } from '@edgevault/diff'
import type { ChangeType, Revision } from './types'

type RevisionRow = {
  id: string
  environment_id: string
  config_key: string
  content_data: string
  content_hash: string
  version: number
  change_type: string
  summary: string | null
  created_at: number
  created_by: string
}

function toRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    environmentId: row.environment_id,
    key: row.config_key,
    content: row.content_data,
    contentHash: row.content_hash,
    version: row.version,
    changeType: row.change_type as ChangeType,
    summary: row.summary,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

/** Append-only version history for config items, with content hashing. */
export class RevisionManager {
  constructor(private readonly sql: SqlStorage) {}

  async create(input: {
    environmentId: string
    key: string
    content: string
    version: number
    changeType: ChangeType
    summary?: string | null
    createdBy: string
  }): Promise<Revision> {
    const id = crypto.randomUUID()
    const contentHash = await hashContent(input.content)
    this.sql.exec(
      `INSERT INTO config_revisions
        (id, environment_id, config_key, content_data, content_hash, version, change_type, summary, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.environmentId,
      input.key,
      input.content,
      contentHash,
      input.version,
      input.changeType,
      input.summary ?? null,
      input.createdBy,
    )
    const row = this.sql
      .exec<RevisionRow>(`SELECT * FROM config_revisions WHERE id = ?`, id)
      .toArray()[0]
    if (!row) throw new Error('Failed to create revision')
    return toRevision(row)
  }

  list(environmentId: string, key: string, limit = 50, offset = 0): Revision[] {
    return this.sql
      .exec<RevisionRow>(
        `SELECT * FROM config_revisions
         WHERE environment_id = ? AND config_key = ?
         ORDER BY version DESC LIMIT ? OFFSET ?`,
        environmentId,
        key,
        limit,
        offset,
      )
      .toArray()
      .map(toRevision)
  }

  get(revisionId: string): Revision | null {
    const row = this.sql
      .exec<RevisionRow>(`SELECT * FROM config_revisions WHERE id = ?`, revisionId)
      .toArray()[0]
    return row ? toRevision(row) : null
  }
}
