---
target: console (apps/console/app)
total_score: 28
p0_count: 0
p1_count: 1
timestamp: 2026-06-05T23-21-47Z
slug: apps-console-app
---
# Console critique #3 — combined report

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live dot + inline save notes good; WS reconnect/closed state not surfaced |
| 2 | Match System / Real World | 3 | Raw UUIDs as page subtitles; authors shown as truncated hashes ("346b9ae7") |
| 3 | User Control and Freedom | 3 | Two-step confirms everywhere; but promote/revert have no preview of what will change |
| 4 | Consistency and Standards | 3 | Kind chips reuse the compare-drift palette — same colors, two unrelated meanings |
| 5 | Error Prevention | 3 | kind/format mismatch and invalid JSON only caught server-side |
| 6 | Recognition Rather Than Recall | 2 | Compare direction held in head; activity rows lack actor + env context |
| 7 | Flexibility and Efficiency | 3 | Semantic search is a real power feature; no shortcuts, no bulk ops, no diff on edit |
| 8 | Aesthetic and Minimalist Design | 3 | Single-column wall of equal-weight h2 sections; weak zoning on the env page |
| 9 | Error Recovery | 3 | Good ref-error detail; but "Save failed (500)" raw codes with no next step |
| 10 | Help and Documentation | 2 | Inline hints only; zero contextual help, no docs link anywhere in the shell |
| **Total** | | **28/40** | **Good — solid foundation, address weak areas** |

## Anti-Patterns Verdict

Not AI slop. Committed point of view: vault register, dog-eared token box, two-step danger voice, honest copy. Generic residue: layout sameness (every page one top-aligned panel column).

Detector adjudication:
- Real: tiny text 0.72rem/~11.5px on th + page-id chip; 128ch p.muted on env page
- Design-intent: violet-on-deep-purple palette (one deliberate brand token); Space Grotesk; one eyebrow per page = named Scorecard Label System. NOTE: body text resolves to fallback Roboto — the brand body/mono faces never loaded into the console.
- False positives (source-verified): gradient-text = select chevron triangles app.css:282; theater-slop-phrase = serialized-DOM noise

## Priority Issues

- [P1] Mobile actions unreachable: .table-scroll pushes Edit/History/Reveal/Delete and dashboard Open off-screen at 375px, no scroll cue. Fix: stacked-card rows below ~640px or pinned action column + visible affordance.
- [P2] "Who changed this" unanswerable: activity rows + revision authors show truncated userId hashes; no actor/env on feed lines. Fix: resolve userIds to name/email (API or BFF), add env context, demote UUIDs to copy-only.
- [P2] One color system, two meanings: kind chips reuse compare-drift palette (grey secret reads disabled); promotion chips map failed=grey (reads neutral). Fix: dedicated kind chips (lock glyph for secret) decoupled from drift; rethink promotion chip mapping.
- [P2] Screen-reader gaps: ::before "●" is the only new-event signal (invisible to AT); "● open" reads bullet aloud; Edit jumps to distant form without focus management; scrolling tables lack scroll-region labels. Fix: aria-hidden dot + visually-hidden "live" text, focus() key field on Edit, labeled scroll regions.
- [P2] Armed-delete reflows the row — buttons shift at the moment of irreversible click. Fix: fixed-height confirm slot or overlay.
- [P3] Client-side validation (JSON/flag shape) before submit; map raw status codes to guidance; 0.72rem table headers; tabular-nums on version columns; docs link in shell; promote/revert preview.

## Persona Red Flags

- Alex: Edit teleports to page-footer form, no anchor/focus; search results link to env not item; no bulk ops or shortcuts.
- Sam: off-screen table actions tab-reachable with no scroll-region label; live signal is CSS-only; window.location SSO buttons aren't real submits.
- Riley: no length guard on 50KB paste; arming layout shift puts Confirm where Cancel was; flag+invalid JSON fails only server-side.

## Minor Observations

- Login block left-aligned in 28rem column leaves empty right gutter at 1440
- Passkey button weaker affordance than other secondary buttons
- tabular-nums only on compare summary
- "live at the edge in seconds" copy is a strength

## Questions

1. If the Assistant promises "what changed and why", why does activity show a hash instead of a person?
2. Would disclosure on create/mint (like new-env) speed the daily browse/edit loop?
3. Edge config for on-call engineers — why is mobile the weakest surface?
