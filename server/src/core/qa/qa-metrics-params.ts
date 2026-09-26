/**
 * `qa_metrics_v1` — every number the QA metric harness is allowed to consult
 * (TASKS D8; GATES §4 CP1; GLOSSARY §8 and §8.1).
 *
 * D8 is "shadow-PCR/PLB + FER/FLR/DAR computed from the shadow pipeline; weekly job".
 * This module is the parameter half of it. The metric functions beside it are pure
 * arithmetic over an explicit input; the weekly job, the scheduler and the readers that
 * fill that input are not here and are not started.
 *
 * ## Why the parameters are versioned data and not constants
 *
 * The same reason D5 gives generally, plus one that is specific to a checkpoint: CP1 is
 * graded against a protocol "written in September 2026 — before the season it grades —
 * and not edited afterwards", and the protocol pins "the synthetic-zone-grid config
 * version". A grid whose pitch or origin could be edited in place would let the graded
 * number move after the fact, which is the one thing the protocol exists to prevent. The
 * evidence artifact CP1 asks for is a "per-perimeter table + grid config version", so
 * every report this package produces carries {@link QA_METRICS}'s version and digest.
 *
 * ## What is deliberately *not* here
 *
 * Numbers that already have a home stay there, because a second copy is a second
 * definition that can disagree:
 *
 *   - FER's window and thresholds and the large-event criteria live in
 *     `lifecycle_params_v1` (ADR-002 D6). `fer.ts` reads them from there.
 *   - DAR's suppression window and the alert-type vocabulary live in `alert_gating_v1`
 *     (ADR-004 D3). `dar.ts` reads them from there.
 *   - The default-sensitivity score floor and the default quiet-hours window live in
 *     `alert_gating_v1` too; `grid-zones.ts` builds the synthetic lattice zones out of
 *     them rather than restating 0.45.
 *   - The poll interval is deployment configuration (`FIRE_WATCH_POLL_INTERVAL_MS`), and
 *     GLOSSARY §8.1 states the ingest budget *relative to it* ("≤ poll interval + 2 min").
 *     Only the "+ 2 min" allowance is a QA parameter; the interval is an input.
 */

import type { DecisionOutcome } from '../alerts/alert-decision.js';
import type { BoundingBox } from '../config/polling-bbox.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

const MINUTE_MS = 60_000;

/**
 * One reported PCR population. GLOSSARY §8 says "Report N = 50 and N = 10", and GATES §4
 * CP1 makes the ≥ 50 ha population the gating one with "the ≥ 10 ha population reported
 * at ≥ 85%: informative, non-gating". The thresholds are "≥ N ha", so the populations
 * nest: every ≥ 50 ha perimeter is also in the ≥ 10 ha population.
 */
export interface PerimeterStratum {
  readonly minAreaHa: number;
  readonly targetRate: number;
  /** Whether missing the target fails the checkpoint, or is only reported. */
  readonly gating: boolean;
}

export interface PerimeterPopulationRule {
  /** GLOSSARY §8 / GATES §4 CP1: "the perimeter buffered by 2 km". */
  readonly bufferKm: number;
  /** Widest first, so a report reads from the gating population down. */
  readonly strata: readonly PerimeterStratum[];
  /**
   * GATES §4 CP1 "Minimum n": "Fewer than 20 qualifying (≥ 50 ha) perimeters in the 2026
   * season makes the live number under-powered". Applies to the gating stratum; the
   * consequence — falling back to a 2024–25 backfill replay — is the protocol's, not
   * this function's, so the report only ever states that the population was under-powered.
   */
  readonly minimumN: number;
}

/**
 * The synthetic zones CP1 substitutes for subscribed ones: "default-sensitivity zones on
 * a fixed 10 km lattice over the AOI, pinned as versioned config-as-data in place of
 * subscribed zones".
 */
export interface SyntheticZoneLattice {
  readonly pitchKm: number;
  /**
   * Pinned literal degrees, **not** derived from `alertableEnvelope()`.
   *
   * That function goes through `Math.cos`, which ECMAScript does not require to be
   * correctly rounded, so two engines may disagree in the last bits of the lattice
   * origin — and a lattice origin that differs by 1e-16 puts a perimeter centroid that
   * sits near a cell edge into a different zone, which changes a graded number. Whole and
   * half degrees are exactly representable as doubles, so this box is the same box
   * everywhere.
   *
   * It contains Bulgaria + 100 km (the alertable area, ≈ 21.08 W to 29.89 E, 40.34 S to
   * 45.11 N) and lies strictly inside `polling_bbox_v1`, which is asserted by the test:
   * a zone outside the polled box could never receive a detection, and a zone inside the
   * alertable area but outside the lattice would be an unevaluated fire.
   */
  readonly bounds: BoundingBox;
  readonly idPrefix: string;
  /** Fixed-width zero padding, so zone ids sort the same way their indices do. */
  readonly idDigits: number;
  /**
   * The one zone field `alert_gating_v1` has no default for. Pinned `true` because a
   * default-sensitivity zone sits exactly at `quietHoursOverrideFloor`, so `true` is what
   * A1.7 describes. It cannot move shadow-PCR either way: quiet hours turn a `send` into
   * a `defer`, and {@link ALERTING_OUTCOMES} counts both.
   */
  readonly newFireOverridesQuietHours: boolean;
}

/**
 * The quantile convention, pinned because an unstated one is a silent parameter.
 *
 * `nearest_rank_inclusive` is the order statistic at 1-based rank `ceil(p · n)`, clamped
 * to `[1, n]`. Three reasons it is the one chosen over the interpolating conventions
 * (R-7 / "exclusive" / the Excel `PERCENTILE.INC` family):
 *
 *   1. **It reports an observation.** A latency budget is a statement about traces that
 *      actually happened; a p95 of 14 min 59 s that no trace ever took is not a fact
 *      about the pipeline. The CP1 evidence artifact is a "latency histogram from
 *      recorded stage timestamps", and an interpolated value is not in the histogram.
 *   2. **It is integer arithmetic.** The rank is `Math.ceil` over a product of a small
 *      integer and a pinned probability; there is no `(1 - g) · x_i + g · x_{i+1}` whose
 *      last bits depend on the order the samples were summed in. Two runs of CI-2's
 *      double-run produce the same bytes because the value is a sample, copied.
 *   3. **It never flatters.** Interpolating between the 19th and 20th of 20 samples
 *      returns something below the maximum; nearest-rank returns the 19th outright.
 *
 * The cost is stated rather than hidden: for n ≤ 19 at p = 0.95 the rank is n, so the
 * "p95" *is* the maximum and carries no information about the tail. Every quantile this
 * package returns therefore reports its own `n` and an `isMaximum` flag, and no caller
 * has to know the arithmetic to see that a sample was too small.
 */
export const QUANTILE_METHODS = ['nearest_rank_inclusive'] as const;
export type QuantileMethod = (typeof QUANTILE_METHODS)[number];

export interface QuantileRule {
  readonly method: QuantileMethod;
  /** GLOSSARY §8: "p50/p95 per stage from the recorded stage timestamps". */
  readonly p50: number;
  readonly p95: number;
}

/**
 * GLOSSARY §8.1, "the part we control". Upstream source latency (`acq_ts` →
 * `available_at`) is deliberately absent: it "is measured and displayed honestly but
 * never budgeted".
 */
export interface PlbBudgetRule {
  /** The "+ 2 min" of "≤ poll interval + 2 min". The interval itself is an input. */
  readonly ingestAllowanceMs: number;
  readonly ingestedToEventUpdatedMs: number;
  readonly eventUpdatedToDecidedMs: number;
  readonly decidedToPushAckMs: number;
  readonly decidedToEmailAckMs: number;
  readonly eventUpdatedToBroadcastMs: number;
  /** "Total controllable, detection row → push ack: ≤ 15 min p95". */
  readonly controllableTotalMs: number;
  /**
   * GATES §4 CP1 shadow-PLB: "p95 of `available_at` → event visible in the registry
   * (`event_updated_at`) — the ingest and clustering stages only … ≤ 15 min p95".
   * The same 15 minutes as the controllable total, over a shorter chain, because at CP1
   * the later stages do not exist yet.
   */
  readonly shadowTotalMs: number;
}

/**
 * GLOSSARY §8 FLR: "events with ≥ 3 lifecycle direction reversals within 48 h ÷ active
 * events".
 */
export interface FlrRule {
  readonly windowHours: number;
  readonly minReversals: number;
}

/**
 * How the FER population treats a closure the E rule did not make.
 *
 * ADR-002 A2.3(3) says the ≥ 14-day unobservable fallback is "excluded from the FER
 * numerator and reported as its own class … so the fallback can never be used to flatter
 * the FER metric". Read literally, numerator-only exclusion does the opposite of the
 * stated purpose: leaving those closures in the denominator while removing their
 * re-attachments *lowers* the rate. The amendment's stated intent is taken as normative
 * over its stated mechanism, so the whole class leaves the population and is reported
 * separately — which is also what "reported as its own class" asks for. The reading is a
 * parameter rather than a hard-coded branch precisely because it is a reading: flipping
 * this to `false` restores the literal text without a code change, under a new version.
 */
export interface FerReportingRule {
  readonly excludeUnobservableClosures: boolean;
}

/** GLOSSARY §8 DAR: "≤ 5% shadow → ≤ 1% steady". */
export interface DarRule {
  readonly shadowMaxRate: number;
  readonly steadyMaxRate: number;
}

export interface QaMetricsParams {
  readonly perimeters: PerimeterPopulationRule;
  readonly lattice: SyntheticZoneLattice;
  readonly quantile: QuantileRule;
  readonly plb: PlbBudgetRule;
  readonly flr: FlrRule;
  readonly fer: FerReportingRule;
  readonly dar: DarRule;
  /**
   * Rates are rounded to this before any comparison with a target, for the same reason
   * `quantizeKm` and `quantizeE` exist: `19 / 20 >= 0.95` happens to hold, but
   * `numerator / denominator` for a rate that is exactly the target is not guaranteed to
   * land on the same double as the literal, and "exactly at the threshold" must be a
   * state a fixture can write down rather than one decided by the last bits.
   */
  readonly rateQuantum: number;
}

/**
 * The outcomes that count as "the alert-decision function returns an alert" (GATES §4
 * CP1 criterion (b)).
 *
 * `send` and `defer` both *decided* an alert — `defer` hands an already-decided alert to
 * the next digest rather than piercing quiet hours, and advances the alert state exactly
 * as `send` does. `seed` (A1.8) and `suppress` decided nothing. Counting `defer` is what
 * keeps shadow-PCR from being a measurement of what hour a fire started in.
 */
export const ALERTING_OUTCOMES: readonly DecisionOutcome[] = Object.freeze([
  'send',
  'defer',
] as const);

export const QA_METRICS: VersionedConfig<QaMetricsParams> = defineConfig(
  'qa_metrics',
  'qa_metrics_v1',
  {
    perimeters: {
      bufferKm: 2,
      strata: [
        { minAreaHa: 50, targetRate: 0.95, gating: true },
        { minAreaHa: 10, targetRate: 0.85, gating: false },
      ],
      minimumN: 20,
    },
    lattice: {
      pitchKm: 10,
      bounds: { west: 21.0, south: 40.0, east: 30.0, north: 45.5 },
      idPrefix: 'qa_grid',
      idDigits: 3,
      newFireOverridesQuietHours: true,
    },
    quantile: {
      method: 'nearest_rank_inclusive',
      p50: 0.5,
      p95: 0.95,
    },
    plb: {
      ingestAllowanceMs: 2 * MINUTE_MS,
      ingestedToEventUpdatedMs: 60_000,
      eventUpdatedToDecidedMs: 10_000,
      decidedToPushAckMs: 60_000,
      decidedToEmailAckMs: 5 * MINUTE_MS,
      eventUpdatedToBroadcastMs: 2_000,
      controllableTotalMs: 15 * MINUTE_MS,
      shadowTotalMs: 15 * MINUTE_MS,
    },
    flr: {
      windowHours: 48,
      minReversals: 3,
    },
    fer: {
      excludeUnobservableClosures: true,
    },
    dar: {
      shadowMaxRate: 0.05,
      steadyMaxRate: 0.01,
    },
    rateQuantum: 1e-9,
  } as const,
);
