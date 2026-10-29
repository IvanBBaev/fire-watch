# CP1 evaluation protocol

*Written 2026-10-30, one day before the checkpoint it grades. Frozen on commit: after this file
lands, it is not edited. A later correction is a new dated file that names this one.*

**Status: late.** GATES §4 asks for this protocol to be written in **September 2026**, before
the season it grades, so the definitions could not be tuned to the result. It was not written
then. This version is written after the season and states that limitation openly. It is still
useful for two reasons. First, every definition below was already pinned in GATES §4 and in
versioned config (`qa_metrics_v1`) before the season, so this file adds no new freedom. Second,
the honest outcome below does not depend on any choice made here.

Decision: [founder decision record 2026-10-30](../decisions/founder-2026-10-30/governance-product.md),
row GP-5.

## 1. What is graded

The two criteria of GATES §4 CP1, unchanged:

| Criterion | Definition | Threshold |
|---|---|---|
| shadow-PCR | GATES §4 CP1 text, implemented by `server/src/core/qa/shadow-pcr.ts` | ≥ 95% on EFFIS perimeters ≥ 50 ha (≥ 10 ha at ≥ 85%, informative) |
| shadow-PLB | p95 of `available_at` → `event_updated_at`, from recorded stage timestamps (`server/src/core/qa/shadow-plb.ts`) | ≤ 15 min p95, no stage red > 1 day |

## 2. What is pinned

- **Metric definitions and parameters:** `qa_metrics_v1`, digest `43e53e7c`
  (`server/src/core/qa/qa-metrics-params.ts`). The report must quote the version and digest it
  ran under. A different digest under the same version is refused by the report store.
- **Synthetic zone grid:** the 10 km lattice in `qa_metrics_v1.lattice` (74×62 cells,
  `server/src/core/qa/grid-zones.ts`).
- **Minimum n:** 20 qualifying (≥ 50 ha) perimeters, as GATES §4 and `qa_metrics_v1` state.
- **Perimeter source:** the EFFIS burnt-area WFS season layer for 2026, cut to
  `polling_bbox_v1`. The fetch date and file sha256 go in the report (as for DS-6 in
  `docs/data/DATASETS.md`).
- **Rates with no population:** a rate whose denominator is zero is `null` and counts as
  missed, never as passed (`qa_metrics_v1` behaviour, TASKS D8).

## 3. The primary read

The 2026 live shadow season was **not recorded**: no host was provisioned (TASKS B9 and the
J-track are unprovisioned), so there are no live `available_at` timestamps and no live
FireEvents. The primary read is therefore the **2024–25 backfill replay** that the
minimum-n rule names as the fallback. Any live-season figures are reported next to it, and
there are none to report.

## 4. Grading rules

1. A criterion without its evidence artifact counts as **missed** (GATES §4, opening rule).
2. **shadow-PLB cannot be computed from a backfill replay.** Archive rows carry `acq_ts`, not
   `available_at`, and `available_at` is the poll time of the first poll that returned the
   row (TASKS D8). A latency read from replayed timestamps would measure the replay, not the
   pipeline. No recorded stage timestamps exist, so **shadow-PLB is missed**.
3. shadow-PCR from the replay is computed and reported for information. It cannot rescue the
   checkpoint, because GATES §4 requires both criteria.
4. **Outcome known in advance: CP1 is missed.** The GATES §4 consequence applies from
   2026-10-31: **the business pauses.** Engineering may continue. No marketing. No spend
   beyond infrastructure. CP2 work that is engineering stays allowed; CP2 business legs wait.
5. The pause lifts only through a new checkpoint decision recorded in `docs/reports/`, based
   on a recorded live shadow run that meets both criteria. It does not lift on a date.

## 5. Checklist for the report (`docs/reports/cp1-2026-10-31.md`)

- [ ] `qa_metrics_v1` version and digest quoted.
- [ ] Perimeter file fetch date and sha256.
- [ ] Per-perimeter table for the replay (perimeter id, area, intersecting event id or none,
      grid zone, alert outcome).
- [ ] shadow-PCR numerator, denominator and rate, for both strata.
- [ ] shadow-PLB: recorded as "no evidence artifact: missed".
- [ ] DST fallback night (25–26 Oct 2026, review 14 M6) shadow-diff review: recorded as "not
      possible: no shadow pipeline ran". This is a finding, not a pass.
- [ ] Named news-log curator: **not yet named** (owner action). Recorded as missing.
- [ ] Outcome line: "CP1 missed; business paused per GATES §4", with the date.

## 6. Limits of this protocol

- It was written late (see the status line). A reader should give its replay figures the
  weight of a post-hoc analysis.
- The replay uses the pipeline as it is on 2026-10-31, not as it would have run in the season.
- The replay perimeters are EFFIS MODIS burnt areas, which miss small fires. That affects
  only the informative ≥ 10 ha stratum.
