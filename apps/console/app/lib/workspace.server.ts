/** Fetch a workspace's identity (name) for page headers. Returns null on any failure —
 * pages fall back to the id rather than breaking. */
export async function getWorkspaceName(
  env: Env,
  token: string,
  workspaceId: string,
): Promise<string | null> {
  const res = await env.API_SERVICE.fetch(`https://api/api/v1/workspaces/${workspaceId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const { workspace } = (await res.json()) as { workspace?: { name?: string } }
  return workspace?.name ?? null
}
