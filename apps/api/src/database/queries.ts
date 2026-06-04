import type { Database } from '@edgevault/database'
import { members, organizations, workspaces } from '@edgevault/database/schema'
import { and, eq } from 'drizzle-orm'

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
  return database
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: members.role,
      createdAt: organizations.createdAt,
    })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(eq(members.userId, userId))
}

export async function isOrgMember(
  database: Database,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    .limit(1)
  return rows.length > 0
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
  return database.select().from(workspaces).where(eq(workspaces.organizationId, organizationId))
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
