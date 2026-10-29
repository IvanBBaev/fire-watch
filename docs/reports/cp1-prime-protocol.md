# CP1′ evaluation protocol

*Written 2026-10-30, before the read it grades. Frozen on commit: a correction is a new dated
file that names this one.* Decision:
[founder record 2026-10-30, round 5](../decisions/founder-2026-10-30/round5.md), R5-2. GATES §4
"CP1′".

## 1. Date

**18 December 2026** if, by 2026-11-15, the FIRMS MAP_KEY exists and the DS-1 fetch
(`docs/data/DATASETS.md` DS-1) has started. Otherwise **15 January 2027**. The date is fixed on
2026-11-16 by a dated line in `docs/reports/README.md`, and nothing else moves it.

## 2. What is graded

CP1's two criteria, definitions and thresholds, unchanged from GATES §4 CP1 and
[`cp1-protocol.md`](cp1-protocol.md) §1–§2. The same `qa_metrics_v1` version, digest and
synthetic grid apply. If a later `qa_metrics` version exists on the read date, the report runs
under `qa_metrics_v1` and may add the newer version's figures as information only.

## 3. Data

- **Detections:** DS-1, 2024 season only, replayed through the pipeline as it is on the read
  date. Live Nov–Dec rows are added when a host has recorded them.
- **Labels:** EFFIS burnt areas for the 2024 season (DATASETS DS-3 identity: fetch date and
  sha256 in the report).
- **Excluded:** the 2025 season. It is D7's touch-once test season (GATES §2), and reading it
  here would spend it.
- **Minimum n:** if 2024 has fewer than 20 qualifying perimeters (≥ 50 ha), the report says so
  and reports the rate with its n. It does not add 2025 to reach 20.

## 4. Grading rules

1. shadow-PCR is graded on the 2024 replay, both strata (≥ 50 ha gating, ≥ 10 ha informative).
2. shadow-PLB is graded only on live rows with recorded stage timestamps. Without them it is
   recorded as "no evidence", not as a pass and not as a miss. It is deferred to the first
   live month.
3. The CP1 business pause lifts only when both criteria have passed on evidence
   (`cp1-protocol.md` §4.5). A CP1′ with PCR passed and PLB deferred records "PCR passed,
   pause holds until live PLB".
4. A PCR miss keeps the pause and goes to D7's refit as a finding.

## 5. Report

`docs/reports/cp1-prime-YYYY-MM-DD.md`. It contains the `qa_metrics_v1` digest, the DS-1 and
DS-3 identities, the per-perimeter table, PCR numerator, denominator and rate per stratum, the
PLB line, and the outcome line.
