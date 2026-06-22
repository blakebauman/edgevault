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

/** An org plus the workspaces the caller can see in it — the data behind the
 * rail's workspace switcher (and ⌘K cross-workspace jump). */
export interface SwitcherOrg {
  id: string
  name: string
  role: string
  workspaces: { id: string; name: string; slug: string }[]
}

/** Fetch every org the caller belongs to, each with its workspaces, for the
 * switcher. One request per org (same fan-out the home page uses); any failure
 * degrades to an empty list rather than blocking the shell. */
export async function loadWorkspaceSwitcher(env: Env, token: string): Promise<SwitcherOrg[]> {
  const headers = { authorization: `Bearer ${token}` }
  const res = await env.API_SERVICE.fetch('https://api/api/v1/organizations', { headers })
  if (!res.ok) return []
  const { organizations } = (await res.json()) as {
    organizations: Array<{ id: string; name: string; role: string }>
  }
  return Promise.all(
    organizations.map(async (org): Promise<SwitcherOrg> => {
      const wsRes = await env.API_SERVICE.fetch(
        `https://api/api/v1/organizations/${org.id}/workspaces`,
        { headers },
      )
      const workspaces = wsRes.ok
        ? ((await wsRes.json()) as { workspaces: SwitcherOrg['workspaces'] }).workspaces
        : []
      return { id: org.id, name: org.name, role: org.role, workspaces }
    }),
  )
}

/** Back-compat name-only accessor. */
export async function getWorkspaceName(
  env: Env,
  token: string,
  workspaceId: string,
): Promise<string | null> {
  return (await getWorkspaceMeta(env, token, workspaceId)).name
}
