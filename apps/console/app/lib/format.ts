/** DO SQLite rows carry unixepoch() seconds; live events carry Date.now() ms.
 * Render either without showing anyone January 1970. */
export function formatTime(epoch: number): string {
  return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toLocaleString()
}

/** Event vocabulary for humans: "config.created" is an enum, "created" is a word. */
const ACTION_LABELS: Record<string, string> = {
  'config.created': 'created',
  'config.updated': 'updated',
  'config.deleted': 'deleted',
  'config.promoted': 'promoted',
  'secret.revealed': 'revealed (audited)',
  'environment.created': 'environment created',
  'promotion.awaiting_approval': 'awaiting approval',
  'api_key.created': 'key minted',
  edge_read: 'edge reads',
}

export function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action
}
