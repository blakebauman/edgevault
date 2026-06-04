import { parseWorkspaceEvent, type WorkspaceEvent } from './events'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface WorkspaceEventsClientOptions {
  /** WebSocket URL, e.g. wss://api.edgevault.io/api/v1/workspaces/<id>/ws?token=... */
  url: string
  onEvent: (event: WorkspaceEvent) => void
  onStatus?: (status: ConnectionStatus) => void
  /** Reconnect with exponential backoff (default true). */
  reconnect?: boolean
  /** Client-driven keepalive interval in ms (default 30s, hibernation-friendly). */
  pingIntervalMs?: number
}

/**
 * Browser/edge WebSocket client for workspace events: auto-reconnect with
 * backoff and a client-driven ping (so the server DO can stay hibernated
 * between messages rather than being woken by a server-side timer).
 */
export class WorkspaceEventsClient {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: WorkspaceEventsClientOptions) {}

  connect(): void {
    this.closed = false
    this.open()
  }

  close(): void {
    this.closed = true
    this.clearPing()
    this.ws?.close()
    this.ws = null
    this.opts.onStatus?.('closed')
  }

  send(message: { type: 'ping' }): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private open(): void {
    this.opts.onStatus?.('connecting')
    const ws = new WebSocket(this.opts.url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.attempt = 0
      this.opts.onStatus?.('open')
      this.startPing()
    })
    ws.addEventListener('message', (event) => {
      const parsed = parseWorkspaceEvent(typeof event.data === 'string' ? event.data : '')
      if (parsed) this.opts.onEvent(parsed)
    })
    ws.addEventListener('close', () => {
      this.clearPing()
      this.opts.onStatus?.('closed')
      if (!this.closed && this.opts.reconnect !== false) this.scheduleReconnect()
    })
    ws.addEventListener('error', () => ws.close())
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 2 ** this.attempt * 500)
    this.attempt++
    setTimeout(() => {
      if (!this.closed) this.open()
    }, delay)
  }

  private startPing(): void {
    this.clearPing()
    this.pingTimer = setInterval(
      () => this.send({ type: 'ping' }),
      this.opts.pingIntervalMs ?? 30_000,
    )
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
