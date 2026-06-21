export interface WorkspaceMeta {
  name: string | null
  /** The caller's org role (owner/admin/member) — gates admin affordances. */
  role: string | null
  /** The org that owns this workspace — lets the rail link its org settings. */
  organizationId: string | null
}

/** Fetch a workspace's identity (name + the caller's role) for page headers and
 * permission-aware UI. Returns nulls on any failure — pages fall back to the id
 * and the most-restricted view rather than breaking. */
export async function getWorkspaceMeta(
  env: Env,
  token: string,
  workspaceId: string,
): Promise<WorkspaceMeta> {
  const res = await env.API_SERVICE.fetch(`https://api/api/v1/workspaces/${workspaceId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { name: null, role: null, organizationId: null }
  const { workspace } = (await res.json()) as {
    workspace?: { name?: string; role?: string; organizationId?: string }
  }
  return {
    name: workspace?.name ?? null,
    role: workspace?.role ?? null,
    organizationId: workspace?.organizationId ?? null,
  }
}

/** Back-compat name-only accessor. */
export async function getWorkspaceName(
  env: Env,
  token: string,
  workspaceId: string,
): Promise<string | null> {
  return (await getWorkspaceMeta(env, token, workspaceId)).name
}
