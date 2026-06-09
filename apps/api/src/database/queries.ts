import type { Database, NotificationChannelType } from '@edgevault/database'
import {
  apiKeys,
  members,
  notificationChannels,
  organizations,
  users,
  workspaces,
} from '@edgevault/database/schema'
import { and, eq, inArray } from 'drizzle-orm'

/** Neon (via Hyperdrive) queries for org/workspace metadata + membership. */

export async function createOrganization(
  database: Database,
  input: { name: string; slug: string; userId: string },
) {
  return database.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name, slug: input.slug })
      .returning()
    if (!org) throw new Error('Failed to create organization')
    await tx.insert(members).values({ organizationId: org.id, userId: input.userId, role: 'owner' })
    return org
  })
}

export async function listOrganizationsForUser(database: Database, userId: string) {
  // Transactional so Hyperdrive never serves its ~60s query cache here — the
  // console re-reads this list immediately after creating an org (same gotcha
  // as the TOTP credential reads).
  return database.transaction(async (tx) =>
    tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: members.role,
        createdAt: organizations.createdAt,
      })
      .from(members)
      .innerJoin(organizations, eq(members.organizationId, organizations.id))
      .where(eq(members.userId, userId)),
  )
}

export async function isOrgMember(
  database: Database,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return (await getMemberRole(database, organizationId, userId)) !== null
}

/** The caller's role in an org (owner/admin/member), or null if not a member. */
export async function getMemberRole(
  database: Database,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    .limit(1)
  return row?.role ?? null
}

/**
 * Does this org require a fresh step-up (passkey/TOTP) before a secret reveal?
 * Read on the reveal path only (low frequency), so a dedicated lookup is fine.
 */
export async function getOrgRequiresStepUpForReveal(
  database: Database,
  organizationId: string,
): Promise<boolean> {
  // Transactional on purpose: a security policy must read fresh. Hyperdrive's
  // ~60s query cache would otherwise let reveals bypass step-up for up to a
  // minute after an org enables it (a no-token reveal caches policy=false, then
  // enabling doesn't take effect until the TTL lapses — confirmed live, ~82s).
  // Hyperdrive never caches in-transaction queries (same fix as the TOTP
  // read-after-write bug).
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({ require: organizations.requireStepUpForReveal })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    return row?.require ?? false
  })
}

/** Set the org's step-up-before-reveal policy. */
export async function setOrgRequireStepUpForReveal(
  database: Database,
  organizationId: string,
  value: boolean,
): Promise<void> {
  await database
    .update(organizations)
    .set({ requireStepUpForReveal: value })
    .where(eq(organizations.id, organizationId))
}

export async function createWorkspace(
  database: Database,
  input: { organizationId: string; name: string; slug: string },
) {
  const [workspace] = await database
    .insert(workspaces)
    .values({ organizationId: input.organizationId, name: input.name, slug: input.slug })
    .returning()
  if (!workspace) throw new Error('Failed to create workspace')
  return workspace
}

export async function listWorkspaces(database: Database, organizationId: string) {
  // Transactional: read-after-write — the console lists workspaces right after
  // creating one; Hyperdrive's query cache must not serve the pre-create list.
  return database.transaction(async (tx) =>
    tx.select().from(workspaces).where(eq(workspaces.organizationId, organizationId)),
  )
}

export async function getWorkspaceWithOrg(
  database: Database,
  workspaceId: string,
): Promise<{ id: string; organizationId: string; name: string } | null> {
  const [row] = await database
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row ?? null
}

/** What dispatch needs to fan a single event out to a channel. */
export interface NotificationChannelRow {
  id: string
  type: NotificationChannelType
  name: string
  encryptedCredentials: string
  events: string[] | null
  enabled: boolean
}

const channelColumns = {
  id: notificationChannels.id,
  type: notificationChannels.type,
  name: notificationChannels.name,
  encryptedCredentials: notificationChannels.encryptedCredentials,
  events: notificationChannels.events,
  enabled: notificationChannels.enabled,
}

export async function listNotificationChannels(
  database: Database,
  workspaceId: string,
): Promise<NotificationChannelRow[]> {
  return database
    .select(channelColumns)
    .from(notificationChannels)
    .where(eq(notificationChannels.workspaceId, workspaceId))
}

export async function getNotificationChannel(
  database: Database,
  workspaceId: string,
  channelId: string,
): Promise<NotificationChannelRow | null> {
  const [row] = await database
    .select(channelColumns)
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, workspaceId),
        eq(notificationChannels.id, channelId),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function createNotificationChannel(
  database: Database,
  input: {
    workspaceId: string
    type: NotificationChannelType
    name: string
    encryptedCredentials: string
    events?: string[]
    createdByUserId: string
  },
) {
  const [created] = await database
    .insert(notificationChannels)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      name: input.name,
      encryptedCredentials: input.encryptedCredentials,
      events: input.events ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning({
      id: notificationChannels.id,
      type: notificationChannels.type,
      name: notificationChannels.name,
      events: notificationChannels.events,
      enabled: notificationChannels.enabled,
      createdAt: notificationChannels.createdAt,
    })
  if (!created) throw new Error('Failed to create notification channel')
  return created
}

export async function deleteNotificationChannel(
  database: Database,
  workspaceId: string,
  channelId: string,
): Promise<boolean> {
  const deleted = await database
    .delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, workspaceId),
        eq(notificationChannels.id, channelId),
      ),
    )
    .returning({ id: notificationChannels.id })
  return deleted.length > 0
}

export async function createApiKey(
  database: Database,
  input: {
    workspaceId: string
    environmentId: string
    name: string
    prefix: string
    keyHash: string
    createdByUserId: string
    scopes?: string[]
  },
) {
  const [created] = await database
    .insert(apiKeys)
    .values({
      workspaceId: input.workspaceId,
      environmentId: input.environmentId,
      name: input.name,
      prefix: input.prefix,
      keyHash: input.keyHash,
      createdByUserId: input.createdByUserId,
      scopes: input.scopes ?? ['read'],
    })
    .returning({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
    })
  if (!created) throw new Error('Failed to create API key')
  return created
}

/**
 * Resolve user ids to a display identity (name, falling back to email) so
 * activity/revision UIs can show people instead of UUIDs. Batched: one query
 * per response, not per row.
 */
export async function getUserDisplayNames(
  database: Database,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await database
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids))
  return new Map(rows.map((r) => [r.id, r.name ?? r.email]))
}
