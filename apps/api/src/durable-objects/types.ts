/** Unified config/flag/secret item kinds stored in a workspace. */
export type ConfigKind = 'config' | 'flag' | 'secret'

export type ChangeType = 'created' | 'updated' | 'deleted' | 'reverted' | 'promoted'

export interface WorkspaceMeta {
  id: string
  name: string
  organizationId: string
  createdAt: number
  updatedAt: number
}

export interface Environment {
  id: string
  name: string
  slug: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface ConfigItem {
  id: string
  environmentId: string
  key: string
  kind: ConfigKind
  content: string
  contentType: string
  isEncrypted: boolean
  version: number
  publishedRevisionId: string | null
  createdAt: number
  updatedAt: number
  createdBy: string
  updatedBy: string
}

export interface Revision {
  id: string
  environmentId: string
  key: string
  content: string
  contentHash: string
  version: number
  changeType: ChangeType
  summary: string | null
  createdAt: number
  createdBy: string
}

export type PromotionStatus = 'pending' | 'completed' | 'failed'

export interface Promotion {
  id: string
  sourceEnvironmentId: string
  targetEnvironmentId: string
  key: string
  sourceRevisionId: string
  targetRevisionId: string | null
  status: PromotionStatus
  createdAt: number
  completedAt: number | null
  createdBy: string
}

export interface ActivityEntry {
  id: string
  action: string
  resourceType: string
  resourceId: string
  userId: string | null
  changes: string | null
  createdAt: number
}

export interface SetConfigInput {
  environmentId: string
  key: string
  kind?: ConfigKind
  content: string
  contentType?: string
  isEncrypted?: boolean
  userId: string
}
