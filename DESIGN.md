---
name: EdgeVault
description: Edge-native config, secrets, and flags — a drafting room in ink and violet, with dark vault panels where the real artifacts render.
colors:
  drafting-gray: "#F3F4F6"
  ledger-ink: "#0F172A"
  relay-violet: "#7B2CBF"
  rollout-orchid: "#9D4EDD"
  plaintext-lilac: "#E0AAFF"
  vault-depth: "#240046"
  artifact-glow: "#C77DFF"
  reading-white: "#FFFFFF"
  ink-body: "#0F172AC7"
  ink-envelope: "#0F172A59"
  ink-rule: "#0F172A24"
typography:
  display:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "56px–72px (per-page token)"
    fontWeight: 500
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "40px–44px"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "20px–22px"
    fontWeight: 600
  body:
    fontFamily: "Roboto Slab, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.16em"
rounded:
  machined: "2px"
  sharp: "0"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "40px"
  xl: "64px"
  2xl: "96px"
  section: "72px–112px (per-page token)"
components:
  button-ledger:
    backgroundColor: "{colors.ledger-ink}"
    textColor: "{colors.reading-white}"
    rounded: "{rounded.machined}"
    padding: "12px 24px"
  button-drafting-line:
    backgroundColor: "transparent"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.machined}"
    padding: "12px 24px"
  link-relay:
    textColor: "{colors.relay-violet}"
  card:
    backgroundColor: "{colors.reading-white}"
    rounded: "{rounded.machined}"
    padding: "{spacing.md}"
  artifact-panel:
    backgroundColor: "{colors.vault-depth}"
    textColor: "{colors.drafting-gray}"
    rounded: "{rounded.machined}"
    padding: "{spacing.md}"
---

# Design System: EdgeVault

## 1. Overview

**Creative North Star: "The Drafting Room"**

EdgeVault's surface is a drafting room: a cool light table (Drafting Gray, never cream), ink
lines, graph-paper grids, registration crop marks, and one working pen of violet. Set into that
room are dark **Vault Depth panels**, the only dark surfaces on the page, and they are reserved
for the product's real artifacts: CLI output, code, NDJSON records. The duality carries meaning:
the light room is where the system is *drawn*; the dark panels are where the *sealed thing*
shows itself. The sports-scorecard register supplies the information design (box-score tables,
tabular numerals, terse row labels), and folded-paper craft supplies the physical gestures
(dog-eared corners mean "unsealed"; perforated tear-lines mean "where the meter starts").

The system explicitly rejects (from PRODUCT.md): gradient-blob heroes, marketing fluff,
Inter-everywhere sameness, fake dashboards, two-tone wordmarks, and full-saturation neon. It is
quiet without being timid: density and literalness are the boldness.

**Key Characteristics:**
- Light technical ground with dark artifact panels; meaning carried by surface, not decoration
- One working accent (Relay Violet); louder siblings appear only in micro-doses
- Box-score information design: claims as labeled table rows, tabular numerals everywhere
- Physical gestures that mean something: dog-ears, perforations, crop marks
- Zero client JS, zero shadows, zero photography — real artifacts are the imagery

## 2. Colors

A light-ground system with a single violet voice; every color role is named in the product's own
vocabulary (carried from the retired stardust brand profile).

### Primary
- **Relay Violet** (#7B2CBF): the one working accent. Links, eyebrows, box-score values,
  diagram labels, sidebar active states. The single-acid-accent role:
  everywhere a value is "in transit", nowhere as decoration.

### Secondary
- **Rollout Orchid** (#9D4EDD): the accent's lighter working partner — dog-ear folds,
  perforation dashes, hover states, changelog hashes. Micro-doses only.
- **Plaintext Lilac** (#E0AAFF): the pale tint; revealed values *inside* Vault panels and footer
  hover. Rare and brief on screen, like plaintext in the system.
- **Artifact Glow** (#C77DFF): syntax accents and labels on dark panels only; never on the light
  ground.

### Tertiary
- **Vault Depth** (#240046): the dark panel surface itself — code artifacts, the scoreboard bar.
  Never a page background; it is a *thing set into* the page.

### Neutral
- **Drafting Gray** (#F3F4F6): the page ground. Cool, chroma-free; deliberately not cream.
- **Ledger Ink** (#0F172A): headlines, primary-CTA fill, the dark footer. Body text runs at 78%
  ink (#0F172AC7); chrome borders at 35% (#0F172A59); hairline rules at 14% (#0F172A24).
- **Reading White** (#FFFFFF): card surfaces on the gray ground; text on Vault panels and footer.

### Named Rules
**The One Accent Rule.** Relay Violet is the only color that *works* on the light ground. If a
second hue appears outside a Vault panel, the screen is wrong.
**The Plaintext Rule.** The louder the value (Orchid → Lilac), the smaller its dose. Lilac at
full-bleed is prohibited; its rarity is the meaning.
**The Vault Rule.** Dark surfaces are panels, never pages. Each one must contain a real artifact;
a dark panel holding marketing copy is a violation.

## 3. Typography

**Display Font:** Space Grotesk (sans-serif fallback)
**Body Font:** Roboto Slab (Georgia fallback)
**Label/Mono Font:** Martian Mono (ui-monospace fallback)

**Character:** Geometric confidence over a print-era slab body — the slab is the deliberate
anti-Inter move — with the product's own monospace as a load-bearing third voice: code, keys,
numerals, and labels are typeset in the material the product is made of.

### Hierarchy
- **Display** (500, 56–72px per page token, 1.02): page heroes only; weight 500 keeps scale from
  shouting.
- **Headline** (600, 40–44px, 1.02, -0.02em): section headings.
- **Title** (600, 20–22px): card and FAQ headings.
- **Body** (400, 16–17px, 1.65–1.7): Roboto Slab at 78% ink; measure capped 52–76ch per context.
- **Label** (400, 10–12px, 0.16em, uppercase): Martian Mono — eyebrows, table headers, metadata,
  footnotes.

### Named Rules
**The Scorecard Label System.** The Martian Mono uppercase kicker is a *named brand system*, not
scaffolding: it is the box-score's row-label voice, and it also runs table headers, footnotes,
and metadata. It earns the section-eyebrow exemption by being one consistent labeling grammar
across all surfaces — change it nowhere, or everywhere.
**The Tabular Rule.** `font-variant-numeric: tabular-nums` wherever a number appears. Numbers
are data; they align.
**The No-Inter Rule.** Inter is banned as an identity face (designer peeve, PRODUCT.md
anti-reference #3).

## 4. Elevation

**Flat by construction.** The system has zero box-shadows; a shadow would imply a light source
the drafting room doesn't have. Depth is *tonal* — three surface levels: Drafting Gray ground →
Reading White card → Vault Depth panel — and *linear*: 1px ink-alpha rules, 1px chrome borders
(#0F172A59), and crop-mark registration corners that frame "measured" regions. The graph-paper
gridwell behind the hero artifact is the deepest spatial cue the system allows.

### Named Rules
**The No-Light-Source Rule.** No `box-shadow`, ever, on the brand surface. If an element needs
separation, it gets a border, a surface change, or crop marks — in that order.

## 5. Components

Machined and literal: 2px corners, square geometry, and components that look like what they are —
tickets perforate, panels seal, tables tabulate.

### Buttons
- **Shape:** machined corners (2px); pills prohibited.
- **Ledger fill (primary):** Ledger Ink bg, white text, 12px 24px padding, Space Grotesk 500.
  Exactly one per view region; always paired with its open-core twin.
- **Drafting line (secondary):** transparent, 1px Ledger Ink border, ink text. The "Self-host it"
  door — always rendered beside the primary (the dual-CTA system).
- **Relay text (tertiary):** Martian Mono 12px uppercase, Relay Violet, underline offset 4px.
- **Hover / Focus:** currently unstyled beyond link color shifts — a known gap; when added, use
  color/border shifts only (no shadows, no translateY).

### Cards / Containers
- **Corner Style:** 2px. **Background:** Reading White on the gray ground. **Border:** 1px
  hairline (#0F172A24). **Shadow Strategy:** none (see Elevation). **Internal Padding:** 24px.
- **Dog-eared variant:** a clipped 26px corner (flat 45° fold, Rollout Orchid) marks anything
  "unsealed" — revealed values, decrypted content. Plain squares stay sealed; the contrast is
  the meaning.

### Artifact Panels (signature)
Vault Depth bg, Drafting Gray text, Martian Mono 12.5px at 1.9 line-height. Syntax: comments in
55% Lilac, success/keys in Artifact Glow, highlights in Plaintext Lilac. Contents must be real,
syntactically valid product output — never screenshots, never invented APIs.

### Box-Score Tables (signature)
Mono labels (10px uppercase 0.14em Relay Violet headers), 1px rules, values in Relay Violet
500, first column in full ink, tabular numerals. Always a labeled table; never floating
big-number stat bars. Framed by crop marks when the region is "measured".

### Ticket Stubs (pricing)
White cards with 1px chrome borders, an internal perforation (2px dashed Orchid with punch-hole
circles matching the page ground), mono detail lists. The tear line is literal: it marks where
the meter starts.

### Navigation
Sticky, 64px, blurred Drafting Gray at 92%, Space Grotesk 500 14px links in 78% ink; hover and
active in Relay Violet; ink-fill CTA at reduced padding. Footer is the inverse room: Ledger Ink
ground, white-alpha links, Artifact Glow column labels, white logo variant.

## 6. Do's and Don'ts

### Do:
- **Do** lead every page's visual weight with a real artifact (CLI output, code, NDJSON) in a
  Vault panel — artifact-as-hero is law, not preference.
- **Do** express claims as box-score rows with a number, a place, or a mechanism (AES-GCM-256,
  HKDF, 282 PoPs) and tabular numerals.
- **Do** keep Relay Violet (#7B2CBF) the only hue on light ground; check body text holds ≥4.5:1
  (78% ink on Drafting Gray passes).
- **Do** declare placeholders visibly (mono footnotes, stub notices) — honesty is a feature.
- **Do** use the dog-ear only where something is genuinely revealed/unsealed.

### Don't:
- **Don't** use gradient-blob heroes, mesh gradients, or floating 3D shapes (PRODUCT.md
  anti-reference #1).
- **Don't** write marketing fluff — no "supercharge your workflow"; every claim checkable
  (anti-reference #2).
- **Don't** use Inter anywhere in the identity (anti-reference #3).
- **Don't** ship fake or blurred dashboards — any UI shown is a real, verifiable artifact
  (anti-reference #4).
- **Don't** split the wordmark into two colors (anti-reference #5), and **don't** reach for
  full-saturation neon — it was tried and rejected as "way too bright" (anti-reference #6).
- **Don't** add box-shadows, pill radii, side-stripe borders, or gradient text — the machined
  flat system has no place for them.
- **Don't** put marketing copy in a Vault panel or use dark surfaces as page grounds.
