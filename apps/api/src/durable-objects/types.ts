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

/**
 * Per-key result of comparing two environments. Secrets are never compared by
 * value: envelope encryption uses a random DEK/IV per write, so identical
 * plaintexts produce different ciphertexts — equality is unknowable without
 * decrypting, which the comparison deliberately never does.
 */
export type EnvComparisonStatus =
  | 'equal'
  | 'drifted'
  | 'only-in-source'
  | 'only-in-target'
  | 'not-comparable'

export interface EnvComparisonSide {
  kind: ConfigKind
  contentType: string
  version: number
  updatedAt: number
  updatedBy: string
}

/**
 * JSON-safe value type so comparison results survive DO RPC serialization.
 * Depth-limited (not recursive) — a truly recursive JSON type sends the RPC
 * type-stripping machinery into infinite instantiation (TS2589). Deeper values
 * still serialize fine at runtime; only the static type bottoms out.
 */
type ComparisonScalar = string | number | boolean | null
type ComparisonValue2 = ComparisonScalar | ComparisonScalar[] | Record<string, ComparisonScalar>
type ComparisonValue1 = ComparisonValue2 | ComparisonValue2[] | Record<string, ComparisonValue2>
export type ComparisonValue =
  | ComparisonValue1
  | ComparisonValue1[]
  | Record<string, ComparisonValue1>

export interface ComparisonDiffEntry {
  type: 'added' | 'removed' | 'modified' | 'unchanged'
  path: string
  oldValue?: ComparisonValue
  newValue?: ComparisonValue
}

export interface EnvComparisonEntry {
  key: string
  status: EnvComparisonStatus
  source?: EnvComparisonSide
  target?: EnvComparisonSide
  /** Structural diff for drifted config/flag items (never present for secrets). */
  diff?: ComparisonDiffEntry[]
  diffSummary?: string
}

export interface EnvComparison {
  sourceEnvironmentId: string
  targetEnvironmentId: string
  entries: EnvComparisonEntry[]
  summary: {
    equal: number
    drifted: number
    onlyInSource: number
    onlyInTarget: number
    notComparable: number
  }
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
