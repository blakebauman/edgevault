---
title: MCP server
description: EdgeVault speaks Model Context Protocol over Streamable HTTP — your agents operate config with the same authz as your humans.
order: 5
---

EdgeVault's control plane is also a remote **MCP server** (Streamable HTTP). Agents read, write,
and promote configuration through the same authorization path as humans — there is no side door.

## Endpoint

```
https://api.edgevault.io/mcp/<workspaceId>
```

Requests authenticate with a Bearer token and are authorized as a **workspace member** — the same
middleware chain (`requireAuth` → `requireWorkspaceMember`) that guards the regular API. An agent
can do exactly what the human owning its token can do, and nothing more.

## Connecting from Claude Code

```sh
claude mcp add edgevault \
  --transport http \
  https://api.edgevault.io/mcp/<workspaceId> \
  --header "Authorization: Bearer <token>"
```

## What agents get

The config tools — read and write configuration, evaluate flags, inspect revision history, and
drive promotions. Every mutation an agent makes lands in the same revision history and audit
warehouse as a human change, attributed to the token's identity: the activity log doesn't care
whether the actor has a pulse.

There is also a stateful agent (`EdgeVaultAgent` — a Durable Object) behind the console's
"what changed & why" feature; the MCP surface is how *your* agents get the same grounding.

## A note on secrets

Agents see what their workspace membership allows. Secret reveals are RBAC-gated like everything
else — and like every reveal, they're audited.
