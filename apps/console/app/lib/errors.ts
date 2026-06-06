/** Status codes become sentences. "Save failed (500)" tells a user nothing;
 * say what happened to their work and what to do next. */
export function friendlyError(status: number, doing: string): string {
  if (status === 401) return `Your session expired while ${doing} — sign in again.`
  if (status === 403) return `You don't have permission for ${doing} — ask an org owner or admin.`
  if (status === 404) return `That no longer exists — it may have been deleted while ${doing}.`
  if (status === 409) return `Something else changed first — reload and retry ${doing}.`
  if (status === 429) return `Rate limited while ${doing} — wait a moment and retry.`
  if (status >= 500) return `The vault hiccuped while ${doing} — nothing was changed. Try again.`
  return `Something went wrong while ${doing} (${status}). Try again.`
}
