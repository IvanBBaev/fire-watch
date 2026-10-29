# Founder decisions — review round 5 acts (2026-10-30)

Decisions on the founder acts that reviews 24–32 put on every seat's critical path
(`reviews/00-summary.md` round 5, TASKS "Pending founder decisions" round-5 block). Recorded
the same day as the other `founder-2026-10-30/` records. The CP1 miss and branch protection
are already decided in [`governance-product.md`](governance-product.md) GP-5 and GP-2; this
record only adds what those two left open.

| ID | Question | Decision | Rationale (cite §) | Implemented in | Revisit when |
|---|---|---|---|---|---|
| R5-1 | Freeze V2/V3 until v1 has run a week on a host? | **Yes.** No V2 or V3 item is started, ticked or merged until v1 has run seven consecutive days on a provisioned host with live ingest and green CI on a protected `main`. Already-merged V2 wave 1/2 code stays on `main`, dark and unticked. Unstarted V3 rows in V3-WORKPLAN §2 are set to `frozen`, so the claim script cannot hand them out. Fixes to merged V2 code are allowed when a v1 gate needs them. | 25 Q1, 26 E-1 and Q1, 32. Every round-5 seat found v1's critical path (host, data, CI, accounts) starved while V2/V3 grew. GATES §4: after the CP1 miss, engineering continues on the critical path only. GP-6 already pauses the D-track on the same reasoning. | V2-FEATURES §7, V3-FEATURES §7, V3-WORKPLAN §2 (freeze notes, `frozen` status) | v1 runs seven days on a host. The freeze lifts by a dated line in this record, not by default. |
| R5-2 | CP1′ date: 18 Dec 2026 or 15 Jan 2027? | **18 Dec 2026, conditional.** The condition is that MAP_KEY exists and the DS-1 backfill fetch has started by **2026-11-15**. If it has not, CP1′ moves to **2027-01-15** automatically, with no new decision. The read uses the **2024 season plus any live Nov–Dec rows**. 2025 stays D7's touch-once test season and is not read. Criteria and thresholds are CP1's. shadow-PLB is graded only if live rows exist; otherwise it is reported as "no evidence" and deferred to the first live month. | 26 E-3 and Q3 (18 Dec, 2024 + live, keep 2025 for D7). 30 E-3 (15 Jan, 2024–25 replay, PCR only). The earlier date keeps the gate meaningful before the 2027 season. The fallback is 30's date. 26 Q3 wins on the season, because reading 2025 would spend the D7 test set (GATES §2 touch-once rule). | GATES §4 "CP1′" subsection | The backfill check on 2026-11-15. The CP1′ report itself. |
| R5-3 | Repository licence | **AGPL-3.0-only for code, CC BY 4.0 for published data and docs, plus a short trademark policy for the product name.** It is not applied yet. The licence file goes in only after (a) a `pnpm licenses` sweep confirms that every dependency licence is AGPL-compatible, and (b) the lawyer engaged under L-10 confirms that the trademark policy text and the name are clear. Until then the repo has no licence grant, which means all rights reserved. | 32 E-5 and Q2: civic, forkable, and blocks closed SaaS copies. Source-available would protect a B2B line the product decisions (GP-13, GP-17) do not depend on. Going private would undo the public-repo goal. CC BY 4.0 matches GP-8's archive licence. | This record. The licence file and the `license` field are a follow-up row in TASKS Track R5. | The dependency sweep finds an incompatible licence, or the lawyer objects. Due 2026-12-31. |
| R5-4 | MAP_KEY and the DS-1 backfill | **Decided as a plan; the act is the owner's.** The MAP_KEY is registered by 2026-11-15, because that is R5-2's trigger. The DS-1 fetch runs on a laptop and is checked with `--check`, per DATASETS DS-1. It finishes by 2026-11-20, when the winter fit window opens. | 30 E-1 and the Nov plan row. 26 §CP1 (start by 15 Nov). | DATASETS DS-1 (unchanged) | — |
| R5-5 | Day 0 accounts and ЕООД / lawyer | **Not decidable by analysis.** Order and dates are kept from 26 and 32: host, R2, domain and mail sender by 2026-11-30, and the ЕООД filing with a lawyer engaged by 2026-11-30. The L-10 chain takes 10–14 weeks. | 26 E-2, 27, 32. | — | — |

## Still owner action

- Register the FIRMS MAP_KEY and start the DS-1 fetch by **2026-11-15**. This decides between 18 Dec and 15 Jan for CP1′.
- Apply branch protection and enable secret scanning, push protection and Dependabot. The exact command is in `docs/ENGINEERING-PRACTICE.md`.
- Open the Day 0 accounts (host, R2, domain, mail sender) by 2026-11-30.
- File the ЕООД and engage the lawyer by 2026-11-30. Add the trademark-policy question to the lawyer's list.
- Lift the V2/V3 freeze by a dated line here once v1 has run seven days on a host.
