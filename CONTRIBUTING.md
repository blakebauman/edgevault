# Contributing to EdgeVault

Thanks for your interest! EdgeVault is open-core: the `apps/*` and `packages/*`
core is MIT-licensed; `ee/*` is the commercial Enterprise Edition; `edge/*` is
proprietary. Contributions are accepted to the **core** (and to docs).

## Developer Certificate of Origin (DCO)

All commits must be signed off under the [DCO](https://developercertificate.org/).
Add a `Signed-off-by` line to each commit:

```sh
git commit -s -m "your message"
```

By signing off you certify you have the right to submit the contribution under
the project's license.

## Getting started

```sh
pnpm install      # also installs git hooks via lefthook
pnpm dev
pnpm typecheck && pnpm test
```

- **Lint/format:** Biome. Run `pnpm check` (auto-fix) before pushing; the
  pre-commit hook runs Biome on staged files automatically.
- **Types:** `pnpm cf-typegen` regenerates `worker-configuration.d.ts` per app.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers` (runs in the real
  Workers runtime).

## Boundary rules

- The MIT core must **never** import from `ee/` or `edge/`.
- Do not add telemetry that phones home. Any analytics must be opt-in.

## Security

Never report vulnerabilities via public issues — see [SECURITY.md](./SECURITY.md).
