/** DO SQLite rows carry unixepoch() seconds; live events carry Date.now() ms.
 * Render either without showing anyone January 1970. */
export function formatTime(epoch: number): string {
  return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toLocaleString()
}
