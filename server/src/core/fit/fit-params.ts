/**
 * The rules a clustering parameter fit is scored and selected under (TASKS D7).
 *
 * Config-as-data for the same reason the clustering parameters are (ADR-002 D5): a fit
 * report is only comparable to the next one if both name the thresholds, the label-join
 * rule and the plateau tolerances they ran under, and "the same version" must mean the
 * same bytes. Every number here is quoted from GATES §2 or review 11 §4 next to where it
 * is used; where the spec leaves a choice open the choice is stated here, once, and the
 * fit report repeats it so a reader never has to open this file to know what was decided.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

/** A size class over the EFFIS `AREA_HA` of the perimeter a detection is labelled with. */
export interface SizeStratum {
  readonly id: string;
  /** Inclusive lower bound, hectares. */
  readonly minHa: number;
  /** Exclusive upper bound, hectares; `null` is unbounded. */
  readonly maxHa: number | null;
  /** Part of the gate (GATES §2 strata) or reported only (the sub-10 ha tail). */
  readonly gated: boolean;
}

export interface FitThresholds {
  /** Pairwise recall over same-fire pairs, at least (GATES §2). */
  readonly pairwiseRecallMin: number;
  /** Pairwise precision over hard negatives only, at least (GATES §2). */
  readonly pairwisePrecisionMin: number;
  /** Over-split index mean, at most. */
  readonly overSplitMeanMax: number;
  /** Over-split index p95 (nearest rank, `qa_metrics_v1`), at most. */
  readonly overSplitP95Max: number;
  /** Chimera rate, at most. */
  readonly chimeraRateMax: number;
  /** Timeline agreement within the tolerance, at least. */
  readonly timelineAgreementMin: number;
}

export interface FitParams {
  readonly thresholds: FitThresholds;
  /**
   * Review 11 §4.1: d matches fire F iff d lies within `max(ε_source(d), floorKm)` of the
   * perimeter and `acq_ts ∈ [F.start − daysBefore, F.end + daysAfter]`. ε is resolved
   * under `labelEpsConfig` — the baseline, never the config being scored — so the
   * labelled population is the same for every grid cell (see `label-join.ts`).
   */
  readonly labelJoin: {
    readonly bufferFloorKm: number;
    readonly daysBefore: number;
    readonly daysAfter: number;
  };
  /** Hard negatives: pairs from different labelled fires within both bounds (11 §4.2). */
  readonly hardNegative: { readonly withinKm: number; readonly withinDays: number };
  /**
   * The 10 % share in the over-split and chimera definitions, as basis points so the
   * comparison `count · 10 000 ≥ bp · total` is integer arithmetic and "exactly 10 %" is a
   * state a hand-computed fixture can reach.
   */
  readonly shareBasisPoints: number;
  /** Timeline agreement: event `started_at` within ± this of the first labelled detection. */
  readonly timelineToleranceHours: number;
  /**
   * GATES §2 strata, half-open `[min, max)`. The spec writes "10–50 / 50–500 / ≥ 500 ha";
   * a perimeter of exactly 50 ha has to land in one of two classes and this puts it in
   * the upper one. Below 10 ha is reported, never gated: EFFIS mapping is reliable only
   * from ~30 ha (11 §4.1), and the 10–50 stratum already carries that caveat.
   */
  readonly sizeStrata: readonly SizeStratum[];
  /** The stratum whose failure fails a pooled pass (GATES §2 "failing bottom stratum"). */
  readonly bottomStratumId: string;
  /** Season split by UTC calendar year of `acq_ts` (11 §9.1, GATES §2). */
  readonly splits: {
    readonly fit: readonly number[];
    readonly calibrate: readonly number[];
    readonly test: readonly number[];
  };
  /**
   * Review 11 §4.6: every ±1-step neighbour within this relative event-count change and
   * this absolute pairwise-F1 change (1 point = 0.01).
   */
  readonly plateau: { readonly eventCountTolerance: number; readonly f1Tolerance: number };
  /**
   * The SP archive has no `available_at` — it is a reprocessed product, nobody received
   * it live. The replay feeds the engine in batches of this width over `acq_ts`, every
   * row made available at its window's end, which is the closest honest stand-in for a
   * poll cadence (the live NRT poll is 15 min; one hour is coarser on purpose, because a
   * finer batch only changes the order of attaches inside one overpass).
   */
  readonly replayBatchMinutes: number;
}

export const FIT_PARAMS: VersionedConfig<FitParams> = defineConfig(
  'clustering_fit',
  'clustering_fit_v1',
  {
    thresholds: {
      pairwiseRecallMin: 0.95,
      pairwisePrecisionMin: 0.98,
      overSplitMeanMax: 1.15,
      overSplitP95Max: 2,
      chimeraRateMax: 0.03,
      timelineAgreementMin: 0.9,
    },
    labelJoin: { bufferFloorKm: 1, daysBefore: 1, daysAfter: 3 },
    hardNegative: { withinKm: 20, withinDays: 7 },
    shareBasisPoints: 1000,
    timelineToleranceHours: 12,
    sizeStrata: [
      { id: 'under_10_ha', minHa: 0, maxHa: 10, gated: false },
      { id: '10_50_ha', minHa: 10, maxHa: 50, gated: true },
      { id: '50_500_ha', minHa: 50, maxHa: 500, gated: true },
      { id: 'ge_500_ha', minHa: 500, maxHa: null, gated: true },
    ],
    bottomStratumId: '10_50_ha',
    splits: { fit: [2020, 2021, 2022, 2023], calibrate: [2024], test: [2025] },
    plateau: { eventCountTolerance: 0.1, f1Tolerance: 0.01 },
    replayBatchMinutes: 60,
  } as const,
);

/** The stratum a perimeter's area falls in. Every non-negative area has exactly one. */
export function stratumOf(areaHa: number, params: FitParams = FIT_PARAMS.values): string {
  for (const stratum of params.sizeStrata) {
    if (areaHa >= stratum.minHa && (stratum.maxHa === null || areaHa < stratum.maxHa)) {
      return stratum.id;
    }
  }
  throw new RangeError(`no size stratum contains ${String(areaHa)} ha`);
}

export type SplitName = 'fit' | 'calibrate' | 'test';

/** The split a season belongs to, or `null` for a year outside all three. */
export function splitOf(season: number, params: FitParams = FIT_PARAMS.values): SplitName | null {
  if (params.splits.fit.includes(season)) return 'fit';
  if (params.splits.calibrate.includes(season)) return 'calibrate';
  if (params.splits.test.includes(season)) return 'test';
  return null;
}
