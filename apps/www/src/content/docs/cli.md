---
title: CLI
description: "edgevault run / pull / get — inject configs, flags, and secrets into any process, zero runtime dependencies, one environment-scoped key."
order: 3
---

The `edgevault` CLI injects your environment's configuration into any process — no SDK, no code
changes. It's a single esbuild-bundled binary with zero runtime dependencies.

```sh
npm install -g @edgevault/cli
export EDGEVAULT_API_KEY=ev_…   # environment-scoped key from the console
```

## `run` — inject and exec

```sh
edgevault run -- node server.js
# edgevault: injected 14 values
```

Fetches the environment's machine export, maps every key into the child's environment, and
execs your command. The child's exit code propagates (a failed spawn exits `127`).

Key names sanitize to env-var form: `feature.timeout` becomes `FEATURE_TIMEOUT`. If two keys
sanitize to the same name you get a warning (`warning: env-name collision: … (later value
wins)`) and **secrets win** over configs.

Secrets are included only when the API key carries the `secrets:read` scope — otherwise the run
proceeds and tells you plainly: `note: secrets omitted — the API key lacks the secrets:read
scope.`

## `pull` — print the environment

```sh
edgevault pull                  # dotenv to stdout (default)
edgevault pull --format json    # JSON object
```

Useful for piping into tooling or inspecting exactly what `run` would inject.

## `get` — one value, off the edge

```sh
edgevault get checkout-timeout-ms
# 5000
```

Reads a single config from the delivery plane (`delivery.edgevault.io`) — the same sub-10 ms path
your SDK uses — and prints the raw content. Missing keys print `not found: <key>` on stderr and
exit `1`.

## The two export surfaces (why secrets are safe here)

- `run`/`pull` use the **api machine export** — the only surface that can include secrets,
  gated by the key's `secrets:read` scope.
- `get` and the SDK use the **delivery plane**, where secrets can't appear at all: they are
  never written to the edge cache.

## Self-hosting

Point the CLI at your own workers:

```sh
export EDGEVAULT_API_URL=https://api.your-domain.dev
export EDGEVAULT_DELIVERY_URL=https://delivery.your-domain.dev
```
