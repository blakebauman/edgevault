---
target: console (apps/console/app)
total_score: 32
p0_count: 0
p1_count: 1
timestamp: 2026-06-06T01-04-35Z
slug: apps-console-app
---
# Console critique #4 — combined report (post design-system migration)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | live status, busy states, versioned save banners — minor: inline-only, no toast |
| 2 | Match System / Real World | 3 | raw enum vocab leaks: "not-comparable", "promotion.awaiting_approval" |
| 3 | User Control and Freedom | 3 | best-in-class confirms; but no undo after the fact despite full revision history |
| 4 | Consistency and Standards | 4 | one Button/CardTable/TokenBox everywhere; 2 hand-rolled confirm copies remain (drift risk) |
| 5 | Error Prevention | 4 | client-side JSON validation, ref-protected deletes, risk-gated promotions |
| 6 | Recognition Rather Than Recall | 3 | UUIDs still H1-adjacent; breadcrumb-only navigation |
| 7 | Flexibility and Efficiency | 2 | no autofocus, shortcuts, bulk actions, date presets, or pagination past 200 |
| 8 | Aesthetic and Minimalist Design | 4 | the standout; density delivered without noise |
| 9 | Error Recovery | 2 | friendlyError exists but raw "(403)/(500)/(502)" still leak on reveal/audit/create paths |
| 10 | Help and Documentation | 3 | strong microcopy + Docs link; no contextual help into docs from surfaces |
| **Total** | | **32/40** | **Good — strong foundation, sand the edges** |

## Anti-Patterns Verdict
NOT SLOP, high confidence: "a coherent, opinionated design system enforced at the token level… reads as a senior product-design point of view, not a template." Detector adjudication: gradient-text FALSE (zero background-clip matches; signal = select chevron), theater FALSE (absent from innerText), em-dash FALSE (counted CSS custom properties), "Roboto" FALSE (system-ui stack mislabel; fonts actually rendering: system sans body + Space Grotesk display + Martian Mono — all loaded). REAL signals: the violet-on-dark palette + per-page eyebrow (deliberate, named brand systems), min real text 12px, zero JS errors.

## Fixed during the run
The mobile masthead overflow (17px at 375px after the Docs link landed; "Share a secret" wrapping, Sign out clipped) — fixed (6d44dde, two-row wrap) and re-verified 0px on dashboard/environment/audit before this synthesis.

## Priority Issues
- [P1] Permission dead-ends: members see admin doors (Billing/OIDC/SAML/SCIM links, mint/reveal actions) that 403 into a bare red line. Fix: carry role into loaders, hide or disable-with-reason, and render real 403 states (who to ask, way back).
- [P2] Error/jargon residue: route the remaining raw-status messages (reveal/audit/create/key paths) through friendlyError; humanize or legend the enum chips.
- [P3] Escalate the production confirm: approving a high-risk promotion has the same ceremony as deleting a webhook — type-the-slug-to-confirm for production targets.
- [P3] Power-user throughput: autofocus (login email, search), audit date presets (7/30 days), bulk select on compare/items, cursor pagination past the 200 cap.
- [P3] Confirm focus management: programmatically focus the newly-rendered Confirm button and put the warning in a live region (TwoStepConfirm is the single place to fix it).

## Persona highlights
Alex: every session starts with a mouse reach (no autofocus); one-at-a-time promotes. Sam: login tab order hits masthead + OAuth before email; armed confirms not announced. Riley: 403 walls; suggests fuzzing 200-char keys in compare.

## Notable strengths
Token-level brand enforcement (2px radius + no-shadow by construction); the dog-ear reveal as emotional peak; zero-shift armed confirms; honest copy throughout ("offline summary", "no undo").

## Questions
1. Why does the most dangerous action get the same 12px confirm as the least?
2. Why show non-admins doors they can't open?
3. Where is the friendlyError equivalent of the token-level pill ban — an enforced rule that no raw status reaches a user?
4. With infinite audit + revisions already stored, why is there no undo?
