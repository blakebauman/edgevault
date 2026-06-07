# Product

## Register

brand

> The repo holds both registers: `apps/www` (+ markdown docs) is the brand surface and the
> current design focus; `apps/console` is product register — override per task when working
> there. Strategic content below was carried verbatim (designer-confirmed 2026-06-05) from the
> stardust design pipeline (since retired and removed — this file, `DESIGN.md`, and
> `.impeccable.md` are now the source of record).

## Users

Three personas, all working engineers, all allergic to marketing:

- **The Platform Engineer** — owns the infra decision; reads architecture before pricing; wants
  the self-host escape hatch to be real, not theater. Motto: "Show me the failure modes."
- **The Product Developer** — ships behind flags daily; cares about SDK ergonomics, React
  bindings, propagation speed. Motto: "If the flag flips, ship it."
- **The Security Reviewer** — reads the encryption page first; wants scheme names and
  blast-radius answers, not badges. Motto: "Adjectives aren't controls."

They arrive from GitHub, HN, search, or a teammate's link — skeptical of SaaS marketing, fluent
in the architecture vocabulary.

## Product Purpose

EdgeVault is edge-native configuration, secrets, and feature-flag management on the Cloudflare
Developer Platform: values served in under 10 ms from 300+ cities, one strongly-consistent
Durable Object per workspace, envelope-encrypted secrets, every change attributed. Open-core: MIT
where it matters, paid tiers that say plainly what they add.

The marketing surface succeeds when an evaluating engineer thinks "I could verify every claim on
this page" — and then picks one of the two doors (start free on the managed edge, or self-host
the MIT core). Both doors appear together at every conversion moment.

## Brand Personality

A staff engineer explaining the system to a peer: **precise, concrete, plainspoken**. Dry wit in
the margins (release notes, 404s, box-score footnotes), never in the claims; zero wit in
security and pricing copy. Voice rules: no exclamation points, banned marketing adjectives,
every claim carries a number, a place, or a mechanism; name the architecture when it's the proof.

References (with the specific thing borrowed):

- **Tailscale / Fly.io** — plainspoken engineering voice; technical editorial that trusts the reader.
- **Swiss / international style** — grid and typographic discipline; hierarchy does the work.
- **A direct category neighbor (secrets management)** — the technical-drawing idiom (crop marks,
  dashed dividers, line-art product visuals), one working accent, dark product panels set into a
  light page. (Extraction reviewed 2026-06-05; the scraped archive was removed with the stardust
  pipeline.)

## Anti-references

Designer-stated, treat as hard anti-rules:

1. **Gradient-blob heroes** — no mesh gradients, floating 3D shapes, generic SaaS hero decoration.
2. **Marketing fluff copy** — no "supercharge your workflow"; claims must be checkable.
3. **Inter-everywhere sameness** — Inter is banned as an identity face; no pill-button dark-hero template.
4. **Fake dashboards** — no invented/blurred product screenshots; any product surface shown is a
   real, syntactically valid artifact (code samples verified against package source).
5. **Two-tone compound wordmarks** ("Edge"+"Vault" split colors) — the SaaS logo tell.
6. **Full-saturation neon on black** — tried (Neon Lights Blackout palette), rejected same day as
   "way too bright". Loud values need dosage discipline.

## Design Principles

1. **Artifact-as-hero.** The product's own material (CLI output, config, API responses,
   NDJSON) is the imagery. Live-typeset, never screenshots. (Designer rule-break, now law.)
2. **Every claim checkable.** Numbers in box-score tables, mechanisms by name (AES-GCM-256,
   HKDF), changelog entries with real git hashes. If it can't be verified, it doesn't ship.
3. **Honesty is a feature.** Placeholders are visibly declared (pricing footnotes, stub
   notices); pages reconcile against the actual code (tiers vs control plane, SDK signatures vs
   source). Saying "not yet published" beats a template.
4. **One accent, used with intent.** Relay violet is the working accent; the loudest values
   (Rollout orchid, Plaintext lilac) appear in micro-doses. Restraint is the register.
5. **View-source-able is the brand.** The marketing site ships 0 KB of client JS; mechanisms you
   can read applies to the site itself.

## Accessibility & Inclusion

WCAG 2.2 AA: ≥4.5:1 body contrast (≥3:1 large text), visible focus states, descriptive alt text
on every artifact panel, `prefers-reduced-motion` alternatives for any motion added. Responsive:
fluid tokens (clamp) with content-driven breakpoints at 640/900px; ≥44px touch targets via
`pointer: coarse`; nothing hidden on mobile (the two-row nav keeps all links visible — no
JS-dependent menus, per the 0-JS principle).
