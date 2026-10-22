# Manual accessibility pass — protocol (L-16, M-1..M-3)

GATES.md §1.2 defines three manual legs: **M-1** (OS font scale), **M-2** (screen readers) and
**M-3** (full keyboard order). L-16 cannot pass until they have been run by a person, dated
and triaged. Review 19 §5.9 sets the cadence: **half a day once per fire season**, with
TalkBack as the primary engine. Ideally, at least once, a session with a person who uses a
screen reader every day. This file is the checklist for that half-day. Each run produces
one file in [records/](records/), copied from
[records/record-template.md](records/record-template.md).

An agent cannot do this. Every check below is about what a person hears, sees or can do on
a real device. CI-18 and the axe sweep in `web/e2e/a11y.e2e.ts` are the automated half, and
they already gate every build.

## Before you start

- **Build under test:** the commit SHA and the URL. Use the staging or production origin
  serving that build, not a dev server.
- **Devices** (review 06 §5.4, review 19 §5.9):
  - a budget Android phone with Chrome and TalkBack (M-1, M-2 primary, M-3 with a
    Bluetooth keyboard if possible);
  - an iPhone with Safari and VoiceOver (M-2);
  - Windows with Firefox and NVDA (M-2, M-3).
- **Data:** a state with at least three active events in the list, so that counts, ordering
  and the event page all have something to show. If the season is quiet, the harness
  fixture origin (`pnpm dev:live` or the e2e fixture) is acceptable. Record which one you
  used.
- Record device model, OS version, browser version and AT version for every leg.

**Scope** (review 19 Appendix A, shared with CI-18):
- Everything inside `.map-pane` is exempt-with-alternative. The map canvas owes parity with
  the DOM, not a hit box.
- Every control outside it is in scope: the list, event pages, filters, settings, About,
  Credits, Privacy, this statement, sign-in, banners and error states.
- The admin plane is out of scope until it has users outside the operating team.

## M-1 — OS font scale and display size (Android)

On the budget Android phone, set Settings → Display → **Font size** and **Display size** to
maximum. Then visit each surface below and take **one screenshot per surface**:

| # | Surface | How to reach it |
|---|---|---|
| 1.1 | Home list | `/` with the bottom sheet open |
| 1.2 | Event page | tap any list row |
| 1.3 | Settings | `/settings` |
| 1.4 | About | `/about` |
| 1.5 | Credits | `/credits` |
| 1.6 | Accessibility statement | `/accessibility` |
| 1.7 | "My location" answer | press "My location" on the map |
| 1.8 | Degradation banner | airplane mode until the banner appears |

**Pass, on every surface:**
- no horizontal scrolling;
- no clipped or truncated text;
- both map controls fully on screen and activatable where they appear;
- the freshness line readable in full.

## M-2 — Screen readers (TalkBack, VoiceOver, NVDA + Firefox)

Run each check on each engine. Write down what the AT actually *says*, not what the DOM
contains.

| # | Check | Pass |
|---|---|---|
| 2.1 | The list | It is announced as a list, with a count. |
| 2.2 | A list row | It announces the fact (what, where, which sensor) **before** the time. |
| 2.3 | Freshness change | When the freshness chip changes, it is announced **once**, politely, and not on every poll. It never interrupts speech (no assertive region). |
| 2.4 | Degradation banner | It is announced when it appears. |
| 2.5 | The map | The map announces its label. Every fact it shows can be reached from the list and the event page without it. |
| 2.6 | Event page | The heading, the facts, the satellite timeline and the "limits of the service" link can all be reached and are read in a sensible order. |
| 2.7 | Filters | Each control announces its name and current value, and a change is reflected in the list. |
| 2.8 | First launch | The onboarding dialog is announced as a dialog. Its content is read. Dismissing it returns focus to the page. |

## M-3 — Full keyboard order (Windows/Firefox, and Android with a keyboard if available)

On every in-scope surface:
1. Tab from the top to the end of the page, then back with Shift+Tab.
2. On first launch, Escape dismisses the onboarding dialog.

| # | Check | Pass |
|---|---|---|
| 3.1 | Order | The focus order follows the visual order. |
| 3.2 | Focus ring | Every stop shows a visible focus ring, and the ring is not hidden under the sticky sheet handle (WCAG 2.4.11). |
| 3.3 | No traps | There is no stop that cannot be left. |
| 3.4 | Escape | Escape closes the onboarding dialog. |
| 3.5 | Reach | Count the Tab stops from the top of `/` to the first list row. |

For 3.5: on 2026-10-22, CI-18 measured stop 16 with WebGL denied, against a bound of 20. Note
whether a skip link exists yet.

## Review 19 Appendix B tasks (time each one)

Review 19 Appendix B defines ten tasks. Run them with TalkBack (primary) and record
pass/fail and the time taken for each:
1. Orient
2. Find
3. Degrade
4. Arm
5. Receive
6. Burst
7. Scale
8. Keyboard
9. Motion
10. Email

Some tasks (Arm, Receive, Burst, Email) need alerts, which have not shipped yet. Record
those as **not applicable — feature absent**, not as a pass.

## Triage

Every finding gets exactly one of these outcomes in the record:

- **Fix before L-16:** the finding blocks an in-scope task (anything in Appendix A), or it
  breaks M-1..M-3's pass condition. A TASKS item is opened and linked.
- **Fix later:** a real barrier that has a working alternative. It is listed in the
  statement's "Known limitations" (`accessibility.knownGaps` in both catalogs) until it is
  fixed.
- **Not a defect:** the finding is AT- or engine-specific behaviour that the product cannot
  change. Give the reason.

After the run:
1. Commit the record.
2. Update the statement's known gaps and date line (`accessibility.dated`).
3. If any *fix before L-16* item is open, L-16 stays unticked.
