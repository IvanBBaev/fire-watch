# Manual accessibility pass — <YYYY-MM-DD>

Copy this file to `records/<YYYY-MM-DD>-manual-pass.md` and fill it in. The protocol is in
[../manual-pass.md](../manual-pass.md). A record is never edited after it is committed. If
a finding is re-triaged, the change goes in the next record.

**Verdict: <PASSED | FAILED | INCOMPLETE>**

| | |
|---|---|
| Date | `<YYYY-MM-DD>` |
| Tester | `<name or role>` (and whether they use AT daily) |
| Build under test | `<commit SHA>` at `<origin URL>` |
| Data | `<live | staging | fixture>` — `<number of active events>` |

## Devices

| Leg | Device | OS version | Browser + version | AT + version |
|---|---|---|---|---|
| M-1 | | | | — |
| M-2 TalkBack | | | | |
| M-2 VoiceOver | | | | |
| M-2 NVDA | | | Firefox | |
| M-3 | | | | — |

## M-1 — OS font scale and display size

| # | Surface | Result | Screenshot | Note |
|---|---|---|---|---|
| 1.1 | Home list | pass \| fail | `<file>` | |
| 1.2 | Event page | | | |
| 1.3 | Settings | | | |
| 1.4 | About | | | |
| 1.5 | Credits | | | |
| 1.6 | Accessibility statement | | | |
| 1.7 | "My location" answer | | | |
| 1.8 | Degradation banner | | | |

## M-2 — Screen readers

| # | Check | TalkBack | VoiceOver | NVDA | What was actually said |
|---|---|---|---|---|---|
| 2.1 | List announced with a count | | | | |
| 2.2 | Row: fact before time | | | | |
| 2.3 | Freshness change announced once, politely | | | | |
| 2.4 | Banner announced | | | | |
| 2.5 | Map label; facts reachable in the DOM | | | | |
| 2.6 | Event page reading order | | | | |
| 2.7 | Filters: name and value | | | | |
| 2.8 | Onboarding dialog | | | | |

## M-3 — Keyboard

| # | Check | Result | Note |
|---|---|---|---|
| 3.1 | Order follows the visual order | | |
| 3.2 | Focus ring on every stop, not hidden | | |
| 3.3 | No traps | | |
| 3.4 | Escape closes onboarding | | |
| 3.5 | Tab stops to the first list row | `<n>` | skip link present: yes \| no |

## Review 19 Appendix B tasks (TalkBack)

| # | Task | Result | Time | Note |
|---|---|---|---|---|
| 1 | Orient | pass \| fail \| n/a | | |
| 2 | Find | | | |
| 3 | Degrade | | | |
| 4 | Arm | | | |
| 5 | Receive | | | |
| 6 | Burst | | | |
| 7 | Scale | | | |
| 8 | Keyboard | | | |
| 9 | Motion | | | |
| 10 | Email | | | |

## Findings and triage

| # | Finding | Where (leg / surface / engine) | Triage | Link |
|---|---|---|---|---|
| F-1 | | | fix before L-16 \| fix later (statement) \| not a defect: `<reason>` | `<TASKS item>` |

## Follow-ups

- [ ] Known gaps in the statement updated (`accessibility.knownGaps`, both catalogs)
- [ ] Statement date line updated (`accessibility.dated`)
- [ ] TASKS items opened for every *fix before L-16* finding
