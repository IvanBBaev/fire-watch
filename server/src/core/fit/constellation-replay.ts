/**
 * The constellation replay (GATES §3 L-14) as one pure function.
 *
 * L-14 asks whether the clustering still meets GATES §2 when the stream holds only the
 * satellites that will fly in a season — for 2027, NOAA-20/21 VIIRS and Sentinel-3 SLSTR,
 * with MODIS and S-NPP gone and the GEO attach-only sources unchanged. A miss forces a
 * constellation-specific re-fit before the season opens. This module answers both halves
 * from the same restricted stream:
 *
 * 1. Restrict: DS-1 and DS-4 rows from `dropped` sources are removed (`constellation.ts`).
 * 2. Acceptance: the incumbent configuration (the live `CLUSTERING_PARAMS`) replayed over
 *    the fit and calibrate seasons of the restricted stream, each split judged against
 *    GATES §2 exactly as the fit judges a cell — pooled and bottom stratum, every view
 *    (per-source included) reported next to them. The test season is never touched here:
 *    the touch-once lock (11 §4.3) belongs to the fit CLI and its `--touch-test-season`.
 * 3. Re-fit: the whole D7 fit (`runFit`) on the restricted stream, so a miss arrives with
 *    the constellation-specific candidate already computed and the per-season spread
 *    11 §4.6 asks for. Its test-season step is likewise off.
 * 4. Coverage: which live sources the acceptance seasons actually contain. L-14 passes
 *    only "with per-source metrics reported"; a live source with no archive rows (NOAA-21
 *    and SLSTR are not in DS-1 today) cannot be reported, so thresholds that hold without
 *    it are recorded as `pass_unproven`, not `pass`.
 */

import { SOURCE_IDS, type SourceId } from '@fire-watch/contracts';

import type { ClusteringParams } from '../clustering/clustering-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import {
  constellationProblems,
  restrictToConstellation,
  sourcesWithRole,
  type Constellation,
} from './constellation.js';
import { replaySeason } from './fit-clustering.js';
import type { FitGridAxes } from './fit-grid.js';
import { allViews, evaluateSeason, poolEvaluations, verdictOf } from './fit-metrics.js';
import type { FitParams } from './fit-params.js';
import { runFit, type FitRunResult, type SplitResult } from './fit-run.js';
import type { FitDetection, LabelPerimeter } from './label-join.js';
import { buildSeasonFrame, seasonOf } from './season-frame.js';

export interface ConstellationReplayInput {
  /** DS-1 rows, every season, unrestricted. */
  readonly detections: readonly FitDetection[];
  /** DS-4 rows (GEO); empty when there is no DS-4. */
  readonly geoDetections: readonly FitDetection[];
  readonly perimeters: readonly LabelPerimeter[];
  readonly constellation: VersionedConfig<Constellation>;
  readonly params: VersionedConfig<FitParams>;
  readonly grid: VersionedConfig<FitGridAxes>;
  /** The configuration in production — what the acceptance half judges. */
  readonly incumbent: VersionedConfig<ClusteringParams>;
  readonly runEpsGeo: boolean;
  readonly progress?: (note: { readonly stage: string; readonly detail: string }) => void;
}

export type AcceptanceSplit = SplitResult | { readonly skipped: string };

export interface SplitCoverage {
  readonly seasons: readonly number[];
  /** Restricted rows per source over the split's seasons (sources with rows only). */
  readonly rowsBySource: Readonly<Partial<Record<SourceId, number>>>;
}

export type ConstellationOutcome = 'pass' | 'fail' | 'pass_unproven' | 'no_data';

export interface ConstellationVerdict {
  readonly outcome: ConstellationOutcome;
  /** GATES §3 L-14: a threshold miss forces a constellation-specific re-fit. */
  readonly refitRequired: boolean;
  readonly reasons: readonly string[];
}

export interface ConstellationReplayResult {
  readonly constellation: {
    readonly version: string;
    readonly digest: string;
    readonly season: number;
    readonly live: readonly SourceId[];
    readonly attachOnly: readonly SourceId[];
    readonly dropped: readonly SourceId[];
  };
  readonly restriction: {
    readonly detectionRows: number;
    readonly keptDetectionRows: number;
    readonly geoRows: number;
    readonly keptGeoRows: number;
    readonly droppedRows: Readonly<Partial<Record<SourceId, number>>>;
  };
  readonly incumbent: { readonly version: string; readonly digest: string };
  readonly acceptance: { readonly fit: AcceptanceSplit; readonly calibrate: AcceptanceSplit };
  readonly coverage: {
    readonly fit: SplitCoverage;
    readonly calibrate: SplitCoverage;
    /** Live, non-attach-only sources present in at least one acceptance season. */
    readonly measured: readonly SourceId[];
    /** Live, non-attach-only sources absent from every acceptance season. */
    readonly missing: readonly SourceId[];
  };
  readonly refit: FitRunResult;
  readonly verdict: ConstellationVerdict;
}

export function runConstellationReplay(input: ConstellationReplayInput): ConstellationReplayResult {
  const constellation = input.constellation.values;
  const problems = constellationProblems(constellation);
  if (problems.length > 0) {
    throw new Error(
      `constellation ${input.constellation.version} is inconsistent: ${problems.join('; ')}`,
    );
  }
  const params = input.params.values;
  const note = input.progress ?? ((): void => undefined);

  // ── 1. Restrict ────────────────────────────────────────────────────────────────────
  const ds1 = restrictToConstellation(input.detections, constellation);
  const ds4 = restrictToConstellation(input.geoDetections, constellation);
  const droppedRows: Partial<Record<SourceId, number>> = {};
  for (const counts of [ds1.droppedRows, ds4.droppedRows]) {
    for (const id of SOURCE_IDS) {
      const n = counts[id];
      if (n !== undefined) droppedRows[id] = (droppedRows[id] ?? 0) + n;
    }
  }
  note({
    stage: 'restrict',
    detail: `${String(ds1.kept.length)}/${String(input.detections.length)} DS-1 rows kept`,
  });

  // ── 2. Acceptance of the incumbent ─────────────────────────────────────────────────
  const present = new Set(ds1.kept.map((d) => seasonOf(d.acqTsIso)));
  const accept = (split: 'fit' | 'calibrate'): AcceptanceSplit => {
    const seasons = params.splits[split].filter((s) => present.has(s));
    if (seasons.length === 0) return { skipped: `no ${split}-season data` };
    note({ stage: `accept_${split}`, detail: seasons.join(',') });
    const pooled = poolEvaluations(
      seasons.map((season) => {
        const frame = buildSeasonFrame(
          season,
          ds1.kept,
          input.perimeters,
          params,
          input.incumbent.values,
        );
        return evaluateSeason(
          frame,
          replaySeason(frame, input.incumbent, params.replayBatchMinutes),
          params,
        );
      }),
    );
    return {
      seasons,
      eventCount: pooled.eventCount,
      verdict: verdictOf(pooled.tallies, params),
      views: allViews(pooled.tallies),
    };
  };
  const acceptance = { fit: accept('fit'), calibrate: accept('calibrate') };

  // ── 3. Constellation-specific re-fit ───────────────────────────────────────────────
  const refit = runFit({
    detections: ds1.kept,
    geoDetections: ds4.kept,
    perimeters: input.perimeters,
    params: input.params,
    grid: input.grid,
    baseline: input.incumbent,
    touchTestSeason: false,
    runEpsGeo: input.runEpsGeo,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });

  // ── 4. Coverage ────────────────────────────────────────────────────────────────────
  const coverageOf = (split: 'fit' | 'calibrate'): SplitCoverage => {
    const seasons = new Set(params.splits[split].filter((s) => present.has(s)));
    const rowsBySource: Partial<Record<SourceId, number>> = {};
    for (const d of ds1.kept) {
      if (seasons.has(seasonOf(d.acqTsIso)))
        rowsBySource[d.source] = (rowsBySource[d.source] ?? 0) + 1;
    }
    return { seasons: [...seasons], rowsBySource };
  };
  const coverage = { fit: coverageOf('fit'), calibrate: coverageOf('calibrate') };
  const live = sourcesWithRole(constellation, 'live');
  const measured = live.filter(
    (id) =>
      coverage.fit.rowsBySource[id] !== undefined ||
      coverage.calibrate.rowsBySource[id] !== undefined,
  );
  const missing = live.filter((id) => !measured.includes(id));

  return {
    constellation: {
      version: input.constellation.version,
      digest: input.constellation.digest,
      season: constellation.season,
      live,
      attachOnly: sourcesWithRole(constellation, 'attach_only'),
      dropped: sourcesWithRole(constellation, 'dropped'),
    },
    restriction: {
      detectionRows: input.detections.length,
      keptDetectionRows: ds1.kept.length,
      geoRows: input.geoDetections.length,
      keptGeoRows: ds4.kept.length,
      droppedRows,
    },
    incumbent: { version: input.incumbent.version, digest: input.incumbent.digest },
    acceptance,
    coverage: { ...coverage, measured, missing },
    refit,
    verdict: judgeConstellation(acceptance, missing),
  };
}

/**
 * The L-14 verdict. Thresholds are GATES §2 on every acceptance split that has data; a
 * split with no data is not a pass. `pass_unproven` is the honest name for "the numbers
 * hold, but on a stream missing a source the constellation will fly, or on one split only".
 */
export function judgeConstellation(
  acceptance: { readonly fit: AcceptanceSplit; readonly calibrate: AcceptanceSplit },
  missing: readonly SourceId[],
): ConstellationVerdict {
  const splits = (['fit', 'calibrate'] as const).map((name) => ({
    name,
    split: acceptance[name],
  }));
  const ran = splits.flatMap(({ name, split }) => ('skipped' in split ? [] : [{ name, split }]));
  if (ran.length === 0) {
    return {
      outcome: 'no_data',
      refitRequired: false,
      reasons: ['no fit- or calibrate-season rows survive the restriction'],
    };
  }
  const reasons: string[] = [];
  for (const { name, split } of splits) {
    if ('skipped' in split) {
      reasons.push(`${name}: skipped (${split.skipped})`);
      continue;
    }
    for (const view of split.verdict.views) {
      for (const check of view.checks) {
        if (check.met !== true) {
          reasons.push(
            `${name} ${view.view} ${check.metric} ${check.met === null ? 'unmeasured' : 'missed'} (target ${check.target})`,
          );
        }
      }
    }
  }
  const failed = ran.some(({ split }) => !split.verdict.pass);
  if (failed) return { outcome: 'fail', refitRequired: true, reasons };
  const skipped = ran.length < splits.length;
  if (missing.length > 0 || skipped) {
    return {
      outcome: 'pass_unproven',
      refitRequired: false,
      reasons:
        missing.length === 0
          ? reasons
          : [
              ...reasons,
              `live sources with no archive rows, so no per-source metrics: ${missing.join(', ')}`,
            ],
    };
  }
  return { outcome: 'pass', refitRequired: false, reasons };
}
