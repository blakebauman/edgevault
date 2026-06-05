import { DurableObject } from 'cloudflare:workers'
import { generateDiff, summarizeDiff } from '@edgevault/diff'
import type { WorkspaceEvent } from '@edgevault/realtime'
import { type ConfigRef, extractRefs, RefError, resolveRefs } from '@edgevault/refs'
import { ActivityLogger } from './activity-log'
import { PromotionManager } from './promotion-manager'
import { RevisionManager } from './revision-manager'
import type {
  ActivityEntry,
  ComparisonDiffEntry,
  ConfigItem,
  ConfigKind,
  EnvComparison,
  EnvComparisonEntry,
  EnvComparisonSide,
  Environment,
  Promotion,
  PublishTarget,
  PublishTargets,
  Revision,
  SetConfigInput,
  WorkspaceMeta,
} from './types'

type ConfigRow = {
  id: string
  environment_id: string
  config_key: string
  kind: string
  content_data: string
  content_type: string
  is_encrypted: number
  version: number
  published_revision_id: string | null
  created_at: number
  updated_at: number
  created_by: string
  updated_by: string
}

function toConfigItem(row: ConfigRow): ConfigItem {
  return {
    id: row.id,
    environmentId: row.environment_id,
    key: row.config_key,
    kind: row.kind as ConfigKind,
    content: row.content_data,
    contentType: row.content_type,
    isEncrypted: row.is_encrypted === 1,
    version: row.version,
    publishedRevisionId: row.published_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  }
}

type EnvRow = {
  id: string
  name: string
  slug: string
  created_by: string
  created_at: number
  updated_at: number
}

function toComparisonSide(item: ConfigItem): EnvComparisonSide {
  return {
    kind: item.kind,
    contentType: item.contentType,
    version: item.version,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  }
}

/** Parse JSON content for structural diffing; fall back to the raw string. */
function parseForDiff(item: ConfigItem): unknown {
  if (item.contentType === 'json') {
    try {
      return JSON.parse(item.content)
    } catch {
      return item.content
    }
  }
  return item.content
}

function toEnvironment(row: EnvRow): Environment {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * One Durable Object per workspace — the strongly-consistent system of record
 * for that workspace's environments, config/flag/secret items, revisions,
 * promotions, and recent activity. Reached via RPC from the api worker. The
 * <10ms edge read path never touches this DO (it reads pre-resolved values
 * from KV). Real-time WebSocket/SSE push lands in Phase 3.
 */
export class WorkspaceDurableObject extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private readonly revisions: RevisionManager
  private readonly promotions: PromotionManager
  private readonly activity: ActivityLogger

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.initializeSchema()
    this.revisions = new RevisionManager(this.sql)
    this.promotions = new PromotionManager(this.sql)
    this.activity = new ActivityLogger(this.sql)
  }

  private initializeSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_meta (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )`)

    this.sql.exec(`CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )`)

    this.sql.exec(`CREATE TABLE IF NOT EXISTS config_items (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'config',
      content_data TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'json',
      is_encrypted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      published_revision_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      UNIQUE(environment_id, config_key)
    )`)

    this.sql.exec(`CREATE TABLE IF NOT EXISTS config_revisions (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      content_data TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      created_by TEXT NOT NULL
    )`)

    this.sql.exec(`CREATE TABLE IF NOT EXISTS config_promotions (
      id TEXT PRIMARY KEY,
      source_environment_id TEXT NOT NULL,
      target_environment_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      target_revision_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      completed_at INTEGER,
      created_by TEXT NOT NULL
    )`)

    // Additive migration for pre-existing workspaces: the workflow handle and
    // risk verdict arrived after the table did. PRAGMA-guarded, idempotent.
    const promotionColumns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(config_promotions)`)
      .toArray()
      .map((column) => column.name)
    if (!promotionColumns.includes('workflow_instance_id')) {
      this.sql.exec(`ALTER TABLE config_promotions ADD COLUMN workflow_instance_id TEXT`)
    }
    if (!promotionColumns.includes('risk_level')) {
      this.sql.exec(`ALTER TABLE config_promotions ADD COLUMN risk_level TEXT`)
    }

    this.sql.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      user_id TEXT,
      changes TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )`)

    // Outgoing ${...} reference edges per item, so dependents can be found and
    // republished when a referenced item changes. Maintained by setConfig/deleteConfig.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS config_references (
      environment_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      ref_environment_id TEXT NOT NULL,
      ref_key TEXT NOT NULL,
      PRIMARY KEY (environment_id, config_key, ref_environment_id, ref_key)
    )`)
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_refs_target ON config_references(ref_environment_id, ref_key)`,
    )

    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_config_items_env ON config_items(environment_id)`)
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_revisions_env_key ON config_revisions(environment_id, config_key)`,
    )
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)`)
  }

  // --- Workspace metadata -------------------------------------------------

  ensureWorkspace(meta: { id: string; name: string; organizationId: string }): void {
    this.sql.exec(
      `INSERT INTO workspace_meta (id, name, organization_id)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = unixepoch()`,
      meta.id,
      meta.name,
      meta.organizationId,
    )
  }

  getWorkspace(): WorkspaceMeta | null {
    const row = this.sql
      .exec<{
        id: string
        name: string
        organization_id: string
        created_at: number
        updated_at: number
      }>(`SELECT * FROM workspace_meta LIMIT 1`)
      .toArray()[0]
    return row
      ? {
          id: row.id,
          name: row.name,
          organizationId: row.organization_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null
  }

  // --- Environments -------------------------------------------------------

  createEnvironment(input: { name: string; slug: string; userId: string }): Environment {
    const id = crypto.randomUUID()
    this.sql.exec(
      `INSERT INTO environments (id, name, slug, created_by) VALUES (?, ?, ?, ?)`,
      id,
      input.name,
      input.slug,
      input.userId,
    )
    this.activity.log({
      action: 'environment.created',
      resourceType: 'environment',
      resourceId: id,
      userId: input.userId,
      changes: { name: input.name, slug: input.slug },
    })
    this.broadcast({
      type: 'environment.created',
      environmentId: id,
      slug: input.slug,
      at: Date.now(),
    })
    return this.getEnvironment(id) as Environment
  }

  listEnvironments(): Environment[] {
    return this.sql
      .exec<EnvRow>(`SELECT * FROM environments ORDER BY created_at ASC`)
      .toArray()
      .map(toEnvironment)
  }

  getEnvironment(id: string): Environment | null {
    const row = this.sql.exec<EnvRow>(`SELECT * FROM environments WHERE id = ?`, id).toArray()[0]
    return row ? toEnvironment(row) : null
  }

  /**
   * Compare two environments key-by-key. Config/flag values compare by stored
   * content (with a structural diff for drifted items); secrets only report
   * presence — their ciphertext is non-deterministic, so value equality is
   * unknowable without decrypting, which this method never does.
   */
  async compareEnvironments(
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
  ): Promise<EnvComparison> {
    if (!this.getEnvironment(sourceEnvironmentId) || !this.getEnvironment(targetEnvironmentId)) {
      throw new Error('Environment not found')
    }

    const sourceItems = new Map(this.listConfigs(sourceEnvironmentId).map((i) => [i.key, i]))
    const targetItems = new Map(this.listConfigs(targetEnvironmentId).map((i) => [i.key, i]))
    const keys = [...new Set([...sourceItems.keys(), ...targetItems.keys()])].sort()

    const summary = {
      equal: 0,
      drifted: 0,
      onlyInSource: 0,
      onlyInTarget: 0,
      notComparable: 0,
    }
    const entries: EnvComparisonEntry[] = keys.map((key) => {
      const source = sourceItems.get(key)
      const target = targetItems.get(key)
      if (source && !target) {
        summary.onlyInSource++
        return {
          key,
          status: 'only-in-source',
          source: toComparisonSide(source),
        }
      }
      if (!source && target) {
        summary.onlyInTarget++
        return {
          key,
          status: 'only-in-target',
          target: toComparisonSide(target),
        }
      }
      const s = source as ConfigItem
      const t = target as ConfigItem
      const sides = {
        source: toComparisonSide(s),
        target: toComparisonSide(t),
      }
      if (s.kind === 'secret' || t.kind === 'secret') {
        summary.notComparable++
        return { key, status: 'not-comparable', ...sides }
      }
      if (s.content === t.content && s.kind === t.kind) {
        summary.equal++
        return { key, status: 'equal', ...sides }
      }
      const rawDiff = generateDiff(parseForDiff(s), parseForDiff(t))
      // Content is parsed JSON or a raw string, so diff values are JSON-safe.
      const diff = rawDiff as ComparisonDiffEntry[]
      summary.drifted++
      return {
        key,
        status: 'drifted',
        ...sides,
        diff,
        diffSummary: summarizeDiff(rawDiff),
      }
    })

    return { sourceEnvironmentId, targetEnvironmentId, entries, summary }
  }

  // --- References (${KEY} / ${env-slug/KEY}) -------------------------------

  private envIdBySlug(slug: string): string | null {
    const row = this.sql
      .exec<{ id: string }>(`SELECT id FROM environments WHERE slug = ?`, slug)
      .toArray()[0]
    return row?.id ?? null
  }

  /** Resolve one reference relative to the environment its content lives in. */
  private derefRef = (
    ref: ConfigRef,
    environmentId: string,
  ): { id: string; content: string; ctx: string } | null => {
    const targetEnv = ref.envSlug ? this.envIdBySlug(ref.envSlug) : environmentId
    if (!targetEnv) return null
    const item = this.getConfig(targetEnv, ref.key)
    if (!item || item.kind === 'secret') return null
    return {
      id: `${targetEnv}/${ref.key}`,
      content: item.content,
      ctx: targetEnv,
    }
  }

  /**
   * Validate the references in new content BEFORE persisting: every target must
   * exist and not be a secret, and the resulting graph must be acyclic and
   * shallow enough. Throwing here means a broken graph can never be stored, so
   * publish-time resolution is infallible.
   */
  private validateReferences(environmentId: string, key: string, content: string): void {
    const refs = extractRefs(content)
    if (refs.length === 0) return
    for (const ref of refs) {
      const targetEnv = ref.envSlug ? this.envIdBySlug(ref.envSlug) : environmentId
      const target = targetEnv ? this.getConfig(targetEnv, ref.key) : null
      if (target?.kind === 'secret') {
        throw new Error(`Reference error: secrets cannot be referenced (${ref.raw})`)
      }
    }
    try {
      resolveRefs(content, `${environmentId}/${key}`, environmentId, this.derefRef)
    } catch (error) {
      if (error instanceof RefError) throw new Error(`Reference error: ${error.message}`)
      throw error
    }
  }

  /** Items whose content directly references (environmentId, key). */
  getDependents(environmentId: string, key: string): Array<{ environmentId: string; key: string }> {
    return this.sql
      .exec<{ environment_id: string; config_key: string }>(
        `SELECT environment_id, config_key FROM config_references
         WHERE ref_environment_id = ? AND ref_key = ?`,
        environmentId,
        key,
      )
      .toArray()
      .map((row) => ({
        environmentId: row.environment_id,
        key: row.config_key,
      }))
  }

  /** Replace the outgoing reference edges recorded for an item. */
  private updateReferenceEdges(environmentId: string, key: string, content: string | null): void {
    this.sql.exec(
      `DELETE FROM config_references WHERE environment_id = ? AND config_key = ?`,
      environmentId,
      key,
    )
    if (content === null) return
    for (const ref of extractRefs(content)) {
      const targetEnv = ref.envSlug ? this.envIdBySlug(ref.envSlug) : environmentId
      if (!targetEnv) continue // unreachable: validateReferences already passed
      this.sql.exec(
        `INSERT OR IGNORE INTO config_references
           (environment_id, config_key, ref_environment_id, ref_key)
         VALUES (?, ?, ?, ?)`,
        environmentId,
        key,
        targetEnv,
        ref.key,
      )
    }
  }

  /** Expand an item's references for KV publication (secrets pass through). */
  private resolveContent(item: ConfigItem): string {
    if (item.kind === 'secret') return item.content
    try {
      return resolveRefs(
        item.content,
        `${item.environmentId}/${item.key}`,
        item.environmentId,
        this.derefRef,
      )
    } catch {
      // Writes validate the graph and deletes are blocked while referenced, so
      // this should be unreachable — publish the raw content rather than fail.
      return item.content
    }
  }

  /**
   * The item plus every TRANSITIVE dependent, each with fully-resolved content
   * — everything the edge cache must republish after this item changed.
   * Breadth-first over the reference graph, capped to keep the fan-out sane.
   */
  collectPublishTargets(environmentId: string, key: string, limit = 100): PublishTargets {
    const targets: PublishTarget[] = []
    const visited = new Set<string>([`${environmentId}/${key}`])
    const queue: Array<{ environmentId: string; key: string }> = [{ environmentId, key }]
    let truncated = false

    while (queue.length > 0) {
      const current = queue.shift() as { environmentId: string; key: string }
      const item = this.getConfig(current.environmentId, current.key)
      if (item) targets.push({ item, resolvedContent: this.resolveContent(item) })
      for (const dependent of this.getDependents(current.environmentId, current.key)) {
        const id = `${dependent.environmentId}/${dependent.key}`
        if (visited.has(id)) continue
        if (visited.size >= limit) {
          truncated = true
          continue
        }
        visited.add(id)
        queue.push(dependent)
      }
    }
    return { targets, truncated }
  }

  /**
   * Every item in an environment with references expanded — the machine-export
   * surface. Secrets pass through raw (ciphertext); the api layer decides
   * whether the caller may decrypt them.
   */
  listResolvedConfigs(environmentId: string): PublishTarget[] {
    return this.listConfigs(environmentId).map((item) => ({
      item,
      resolvedContent: this.resolveContent(item),
    }))
  }

  // --- Config items -------------------------------------------------------

  async setConfig(input: SetConfigInput): Promise<ConfigItem> {
    const kind = input.kind ?? 'config'
    const contentType = input.contentType ?? 'json'
    const isEncrypted = input.isEncrypted ? 1 : 0

    if (kind === 'secret') {
      // Becoming a secret while referenced would break dependents at publish time.
      const dependents = this.getDependents(input.environmentId, input.key)
      if (dependents.length > 0) {
        throw new Error(
          `Reference error: "${input.key}" is referenced by ${dependents.length} item(s) and cannot be a secret`,
        )
      }
    } else {
      this.validateReferences(input.environmentId, input.key, input.content)
    }

    const existing = this.sql
      .exec<ConfigRow>(
        `SELECT * FROM config_items WHERE environment_id = ? AND config_key = ?`,
        input.environmentId,
        input.key,
      )
      .toArray()[0]

    const version = existing ? existing.version + 1 : 1
    const changeType = existing ? 'updated' : 'created'

    const revision = await this.revisions.create({
      environmentId: input.environmentId,
      key: input.key,
      content: input.content,
      version,
      changeType,
      createdBy: input.userId,
    })

    if (existing) {
      this.sql.exec(
        `UPDATE config_items
         SET content_data = ?, content_type = ?, kind = ?, is_encrypted = ?, version = ?,
             published_revision_id = ?, updated_at = unixepoch(), updated_by = ?
         WHERE id = ?`,
        input.content,
        contentType,
        kind,
        isEncrypted,
        version,
        revision.id,
        input.userId,
        existing.id,
      )
    } else {
      this.sql.exec(
        `INSERT INTO config_items
          (id, environment_id, config_key, kind, content_data, content_type, is_encrypted, version,
           published_revision_id, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        input.environmentId,
        input.key,
        kind,
        input.content,
        contentType,
        isEncrypted,
        version,
        revision.id,
        input.userId,
        input.userId,
      )
    }

    this.updateReferenceEdges(
      input.environmentId,
      input.key,
      kind === 'secret' ? null : input.content,
    )

    this.activity.log({
      action: `config.${changeType}`,
      resourceType: kind,
      resourceId: input.key,
      userId: input.userId,
      changes: { environmentId: input.environmentId, version },
    })

    this.broadcast({
      type: 'config.changed',
      environmentId: input.environmentId,
      key: input.key,
      kind,
      version,
      at: Date.now(),
    })

    return this.getConfig(input.environmentId, input.key) as ConfigItem
  }

  getConfig(environmentId: string, key: string): ConfigItem | null {
    const row = this.sql
      .exec<ConfigRow>(
        `SELECT * FROM config_items WHERE environment_id = ? AND config_key = ?`,
        environmentId,
        key,
      )
      .toArray()[0]
    return row ? toConfigItem(row) : null
  }

  listConfigs(environmentId: string, kind?: ConfigKind): ConfigItem[] {
    const rows = kind
      ? this.sql.exec<ConfigRow>(
          `SELECT * FROM config_items WHERE environment_id = ? AND kind = ? ORDER BY config_key ASC`,
          environmentId,
          kind,
        )
      : this.sql.exec<ConfigRow>(
          `SELECT * FROM config_items WHERE environment_id = ? ORDER BY config_key ASC`,
          environmentId,
        )
    return rows.toArray().map(toConfigItem)
  }

  async deleteConfig(environmentId: string, key: string, userId: string): Promise<boolean> {
    const existing = this.getConfig(environmentId, key)
    if (!existing) return false
    const dependents = this.getDependents(environmentId, key)
    if (dependents.length > 0) {
      throw new Error(
        `Reference error: "${key}" is referenced by ${dependents.length} item(s) and cannot be deleted`,
      )
    }
    await this.revisions.create({
      environmentId,
      key,
      content: existing.content,
      version: existing.version + 1,
      changeType: 'deleted',
      createdBy: userId,
    })
    this.sql.exec(
      `DELETE FROM config_items WHERE environment_id = ? AND config_key = ?`,
      environmentId,
      key,
    )
    this.updateReferenceEdges(environmentId, key, null)
    this.activity.log({
      action: 'config.deleted',
      resourceType: existing.kind,
      resourceId: key,
      userId,
      changes: { environmentId },
    })
    this.broadcast({
      type: 'config.deleted',
      environmentId,
      key,
      at: Date.now(),
    })
    return true
  }

  // --- Revisions ----------------------------------------------------------

  listRevisions(environmentId: string, key: string, limit = 50, offset = 0): Revision[] {
    return this.revisions.list(environmentId, key, limit, offset)
  }

  async revertToRevision(revisionId: string, userId: string): Promise<ConfigItem | null> {
    const revision = this.revisions.get(revisionId)
    if (!revision) return null
    return this.setConfig({
      environmentId: revision.environmentId,
      key: revision.key,
      content: revision.content,
      userId,
    })
  }

  // --- Promotions ---------------------------------------------------------

  async promote(input: {
    sourceEnvironmentId: string
    targetEnvironmentId: string
    key: string
    userId: string
  }): Promise<Promotion> {
    const source = this.getConfig(input.sourceEnvironmentId, input.key)
    if (!source?.publishedRevisionId) {
      throw new Error('Source config not found or has no published revision')
    }
    const promotion = this.promotions.create({
      sourceEnvironmentId: input.sourceEnvironmentId,
      targetEnvironmentId: input.targetEnvironmentId,
      key: input.key,
      sourceRevisionId: source.publishedRevisionId,
      createdBy: input.userId,
    })
    try {
      const target = await this.setConfig({
        environmentId: input.targetEnvironmentId,
        key: input.key,
        kind: source.kind,
        content: source.content,
        contentType: source.contentType,
        isEncrypted: source.isEncrypted,
        userId: input.userId,
      })
      this.promotions.markCompleted(promotion.id, target.publishedRevisionId ?? '')
      this.activity.log({
        action: 'config.promoted',
        resourceType: source.kind,
        resourceId: input.key,
        userId: input.userId,
        changes: {
          from: input.sourceEnvironmentId,
          to: input.targetEnvironmentId,
        },
      })
      this.broadcast({
        type: 'promotion.completed',
        key: input.key,
        sourceEnvironmentId: input.sourceEnvironmentId,
        targetEnvironmentId: input.targetEnvironmentId,
        at: Date.now(),
      })
      return this.promotions.get(promotion.id) as Promotion
    } catch (error) {
      this.promotions.markFailed(promotion.id)
      throw error
    }
  }

  listPromotions(limit = 50, offset = 0): Promotion[] {
    return this.promotions.list(limit, offset)
  }

  // --- Promotion workflow (split create/apply for an approval gate) ---------

  /** Snapshot the source config and record a pending promotion (no copy yet). */
  createPendingPromotion(input: {
    sourceEnvironmentId: string
    targetEnvironmentId: string
    key: string
    userId: string
    workflowInstanceId?: string | null
  }): Promotion {
    const source = this.getConfig(input.sourceEnvironmentId, input.key)
    if (!source?.publishedRevisionId) {
      throw new Error('Source config not found or has no published revision')
    }
    return this.promotions.create({
      sourceEnvironmentId: input.sourceEnvironmentId,
      targetEnvironmentId: input.targetEnvironmentId,
      key: input.key,
      sourceRevisionId: source.publishedRevisionId,
      createdBy: input.userId,
      workflowInstanceId: input.workflowInstanceId ?? null,
    })
  }

  /** Record the workflow's risk verdict on the promotion row (console display). */
  setPromotionRisk(promotionId: string, riskLevel: string): void {
    this.promotions.setRisk(promotionId, riskLevel)
  }

  /** Apply an approved promotion by copying the SNAPSHOTTED source revision. */
  async applyPromotion(promotionId: string, userId: string): Promise<ConfigItem> {
    const promotion = this.promotions.get(promotionId)
    if (!promotion) throw new Error('Promotion not found')
    const revision = this.revisions.get(promotion.sourceRevisionId)
    if (!revision) throw new Error('Snapshotted source revision not found')
    const source = this.getConfig(promotion.sourceEnvironmentId, promotion.key)

    const target = await this.setConfig({
      environmentId: promotion.targetEnvironmentId,
      key: promotion.key,
      kind: source?.kind,
      content: revision.content,
      contentType: source?.contentType,
      userId,
    })
    this.promotions.markCompleted(promotionId, target.publishedRevisionId ?? '')
    this.broadcast({
      type: 'promotion.completed',
      key: promotion.key,
      sourceEnvironmentId: promotion.sourceEnvironmentId,
      targetEnvironmentId: promotion.targetEnvironmentId,
      at: Date.now(),
    })
    this.activity.log({
      action: 'config.promoted',
      resourceType: source?.kind ?? 'config',
      resourceId: promotion.key,
      userId,
      changes: {
        from: promotion.sourceEnvironmentId,
        to: promotion.targetEnvironmentId,
        via: 'workflow',
      },
    })
    return target
  }

  failPromotion(promotionId: string): void {
    this.promotions.markFailed(promotionId)
  }

  getPromotion(promotionId: string): Promotion | null {
    return this.promotions.get(promotionId)
  }

  // --- Activity -----------------------------------------------------------

  listActivity(limit = 50, offset = 0): ActivityEntry[] {
    return this.activity.list(limit, offset)
  }

  // --- Real-time (WebSocket Hibernation) ----------------------------------

  /**
   * Upgrade to a hibernatable WebSocket. The api worker forwards the upgrade
   * here with verified `?user=` and an optional `?env=` filter (or `*` for all
   * environments). Connection context is stored via serializeAttachment so it
   * survives hibernation without an in-memory map.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const url = new URL(request.url)
    const userId = url.searchParams.get('user') ?? 'anonymous'
    const environmentId = url.searchParams.get('env') ?? '*'

    const { 0: client, 1: server } = new WebSocketPair()
    // Tag by env + user so connections are addressable after hibernation.
    this.ctx.acceptWebSocket(server, [`env:${environmentId}`, `user:${userId}`])
    server.serializeAttachment({ userId, environmentId })

    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    try {
      const parsed = JSON.parse(message) as { type?: string }
      if (parsed.type === 'ping') ws.send(JSON.stringify({ type: 'pong', at: Date.now() }))
    } catch {
      // ignore malformed client messages
    }
  }

  override webSocketClose(ws: WebSocket): void {
    try {
      ws.close()
    } finally {
      this.broadcastPresence()
    }
  }

  override webSocketError(ws: WebSocket): void {
    ws.close()
  }

  /** Send an event to sockets subscribed to its environment (or to all). */
  private broadcast(event: WorkspaceEvent): void {
    const targetEnv = 'environmentId' in event ? event.environmentId : null
    const payload = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as {
        environmentId: string
      } | null
      const subscribedEnv = att?.environmentId ?? '*'
      if (targetEnv === null || subscribedEnv === '*' || subscribedEnv === targetEnv) {
        try {
          ws.send(payload)
        } catch {
          // socket is gone; close handler will clean up
        }
      }
    }
  }

  private broadcastPresence(): void {
    const users = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { userId: string } | null
      if (att?.userId) users.add(att.userId)
    }
    const payload = JSON.stringify({
      type: 'presence',
      users: [...users],
      at: Date.now(),
    })
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {
        // ignore
      }
    }
  }
}
