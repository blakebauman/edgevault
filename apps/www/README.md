# @edgevault/www

The marketing site (edgevault.io) — a fully static Astro build served by an
assets-only Worker. Ships **0 KB of client JS** on purpose; revisit only if a
page ever needs an interactive island.

## Design decision-of-record

The original stardust design pipeline (brand profile, briefings, prototypes) was
retired 2026-06-06 after its decisions were carried into the repo:

- `/DESIGN.md` + `/.impeccable/design.json` — palette, type, motifs, voice
  (tokens mirrored in `src/styles/global.css`)
- `/PRODUCT.md` — **owns all page copy strategy**, personas, key messages;
  edit intent there first, then port the words here

This app is the implementation canon; the rendered pages are now also the only
copy-of-record for the literal words on each page.

## Structure

- `src/layouts/Base.astro` — head (meta/OG/canonical/fonts/viewport), Nav, Footer.
  Responsive via fluid `clamp()` tokens + content-driven breakpoints (640/900px);
  mobile nav is a two-row layout with a scrollable link rail — no JS menu, nothing
  hidden (the site ships 0 KB of client JS).
- `src/components/Nav.astro` / `Footer.astro` — shared chrome. The GitHub star
  chip is intentionally absent (repo is private); Docs links are intentionally
  dead until a docs site exists.
- `src/styles/global.css` — design tokens + shared components (box-score,
  crop-marks, artifact panels, dog-ears). Page-specific rhythm overrides live
  in each page's `<style is:global>`.
- `src/pages/` — index, pricing, security, 404.

## Commands

```sh
pnpm dev      # astro dev
pnpm build    # astro build + wrangler deploy --dry-run
pnpm preview  # astro build + wrangler dev (serves dist/ like production)
pnpm deploy   # astro build + wrangler deploy        → edgevault.io
              # wrangler deploy --env staging        → www-staging.edgevault.io
```

## Content gotchas

- Literal `{`/`}` in code artifacts must be written as `&lbrace;`/`&rbrace;`
  (Astro parses braces as expressions).
- Pricing numbers are launch placeholders (Stripe unactivated); tier structure
  is reconciled against `edge/control-plane` — keep it that way. There is no
  feature-gating (every feature is core); tiers differ only on usage + support.
