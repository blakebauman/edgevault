---
title: Realtime events
description: "@edgevault/realtime — subscribe to config, flag, and secret changes over hibernatable WebSockets instead of polling."
order: 5
---

Your workspace's Durable Object broadcasts every change over WebSockets. `@edgevault/realtime`
is the client: auto-reconnect with exponential backoff, and a **client-driven ping** so the
server DO can hibernate between messages instead of being kept awake by a timer.

## React

```ts
import { useWorkspaceEvents } from '@edgevault/realtime/react'

const status = useWorkspaceEvents(url, (event) => {
  if (event.type === 'config.changed') refresh(event.key)
})
```

`useWorkspaceEvents(url, onEvent)` takes the WebSocket URL as its first argument — e.g.
`wss://api.edgevault.io/api/v1/workspaces/<id>/ws?token=…` — and returns the connection status
(`'connecting' | 'open' | 'closed'`). Pass `null` as the url to stay disconnected (e.g. before
auth is ready).

## The event union

```ts
type WorkspaceEvent =
  | { type: 'config.changed'; environmentId: string; key: string; kind: 'config' | 'flag' | 'secret'; version: number; at: number }
  | { type: 'config.deleted'; environmentId: string; key: string; at: number }
  | { type: 'environment.created'; environmentId: string; slug: string; at: number }
  | { type: 'promotion.completed'; key: string; sourceEnvironmentId: string; targetEnvironmentId: string; at: number }
  | { type: 'presence'; users: string[]; at: number }
  | { type: 'pong'; at: number }
```

`config.changed` carries the `kind` — secret events tell you *that* a secret changed, never its
value.

## Outside React

```ts
import { WorkspaceEventsClient } from '@edgevault/realtime'

const client = new WorkspaceEventsClient({
  url,
  onEvent: (event) => handle(event),
  onStatus: (status) => log(status), // optional
  reconnect: true, // default — exponential backoff
  pingIntervalMs: 30_000, // default — hibernation-friendly keepalive
})

client.connect()
// later:
client.close()
```

The console's live dashboard runs on exactly this client — if you want to see the stream working,
open a workspace in two tabs and change something.
