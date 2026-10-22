# Accessibility — L-16 status

This folder holds the human half of release gate **L-16** (GATES.md §3: "Accessibility
statement + dated manual AT pass (M-1..M-3)"). The automated half lives in the code and
runs in CI. This page lists every L-16 pass condition and its state, so the gate can be
read in one place.

| L-16 pass condition (GATES.md §3) | State | Where |
|---|---|---|
| CI-18 layout criteria pass (reflow, 44 px targets, 16 px text, clipping; four viewports; keyboard bound) | **built** — green on every route in the route table | `web/e2e/a11y.e2e.ts` |
| axe-core: zero serious/critical violations on the in-scope DOM | **built** (TASKS L16, 2026-10-22). It covers every route surface, the degradation banner, first-launch onboarding and the no-WebGL list, in `bg` at 320 px and `en` at 360 px, with `.map-pane` excluded. It found no serious or critical violation on its first run. | `web/e2e/a11y.e2e.ts`, "L-16 axe-core" |
| Accessibility statement published, with the legal position | **draft built** — `/accessibility`, linked from About. All copy is `PENDING_FOUNDER_REVIEW`, and the page shows a draft notice until it is cleared. | `web/src/ui/pages/accessibility.tsx`, `accessibility.*` in the catalogs |
| M-1..M-3 executed and dated, findings triaged | **open: human act.** The protocol and the record template are ready, but no record exists yet. | [manual-pass.md](manual-pass.md), [records/](records/) |
| Canvas/DOM parity asserted in CI (19 §5.4; proposed CI-16) | **open.** It is a proposal and has not landed. Its CI number collides with another proposal (GATES.md CI numbering note). | — |
| Alert-path items (19 §5.3: fact-first push title, plain-text email part, polite coalesced `aria-live`, non-drag radius, text confirmation of what was armed) | **open** — alerts have not shipped. Each item lands with its own alert surface (TASKS H). | — |

## Advisory findings (not gating)

L-16 fails only on `serious` and `critical` violations. The axe sweep prints `moderate` and
`minor` findings without asserting them. They go to the next manual pass's triage. On
2026-10-22 there was one finding:

- `page-has-heading-one` (moderate) on the home list, the event-not-found branch, the
  degradation-banner state and the no-WebGL list. These surfaces have no `<h1>`. Adding one
  means new heading copy in both locales, which is the founder's call.

## Founder and legal decisions this item waits on

1. **WCAG target version** — 2.1 AA (review 09 §4.3, EN 301 549 v3.2.1) or 2.2 AA (review 19
   §6 Q1, GATES L-16 wording). TASKS.md lists this as an open decision. The draft statement
   says 2.2 AA because the gate does.
2. **Statement copy and the legal position.** The statement claims the EAA microenterprise
   exemption (Directive 2019/882 Art. 4(5); Bulgarian Act on the Accessibility Requirements
   for Products and Services, Art. 46(3)) and makes a voluntary commitment. A lawyer has to
   confirm that position, and the Bulgarian text needs review.
3. **Reporting address.** Review 19 §5.10.1 wants a contact route, which is the support inbox
   of review 18 §5.3. It does not exist yet. The statement says it will be published before
   launch.
4. **Skip link and `<h1>` copy.** Both are new user-facing strings (GLOSSARY change), and both
   appear in the statement's known-gaps list or in the advisory findings above.

When the decisions are made: clear the `accessibility.*` paths from `PENDING_FOUNDER_REVIEW`
(the draft-notice test then lets the notice be removed). Update the statement's date line
and its known-gaps list from the latest dated record.
