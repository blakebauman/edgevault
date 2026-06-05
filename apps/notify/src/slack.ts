import type { NotificationEvent } from '@edgevault/edge-protocol'

/**
 * Slack incoming-webhook formatting (Block Kit). One compact message per event;
 * `text` doubles as the notification fallback. Secret values never appear here —
 * events carry keys and metadata only.
 */

function headline(event: NotificationEvent): string {
  const key = event.key ? `\`${event.key}\`` : ''
  switch (event.action) {
    case 'config.created':
      return `🆕 ${event.resourceType} ${key} created`
    case 'config.updated':
      return `✏️ ${event.resourceType} ${key} updated`
    case 'config.deleted':
      return `🗑️ ${event.resourceType} ${key} deleted`
    case 'config.promoted':
      return `🚀 ${key} promoted`
    case 'promotion.awaiting_approval':
      return `⏸️ Promotion of ${key} needs approval`
    case 'secret.revealed':
      return `👀 Secret ${key} was revealed`
    case 'test':
      return '🔔 EdgeVault test notification — this channel works'
    default:
      return `${event.action} ${key}`.trim()
  }
}

export interface SlackMessage {
  text: string
  blocks: Array<Record<string, unknown>>
}

export function formatSlackMessage(event: NotificationEvent): SlackMessage {
  const text = headline(event)
  const facts: string[] = [`*Workspace:* ${event.workspaceId}`]
  if (event.environmentId) facts.push(`*Environment:* ${event.environmentId}`)
  facts.push(`*By:* ${event.userId}`)
  if (event.detail) {
    for (const [name, value] of Object.entries(event.detail)) {
      facts.push(`*${name}:* ${value}`)
    }
  }

  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: facts.join('  ·  ') }] },
    ],
  }
}
