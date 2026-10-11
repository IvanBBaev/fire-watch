/**
 * The whole parameter fit as one pure function (TASKS D7; GATES §2; review 11 §4, §9.1).
 *
 * 1. Frames: one per season, from DS-1 rows and DS-3 perimeters (`season-frame.ts`).
 * 2. Grid: every cell of `FIT_GRID` replayed over the **fit** seasons (2020–23), scored,
 *    pooled across seasons by tally addition, and judged against GATES §2.
 * 3. Plateau: the centre of the widest acceptable region (`plateau.ts`). No acceptable
 *    cell → no selection, and everything below that needs one is skipped and says so.
 * 4. Calibrate: the selected config, once, on 2024. Reported with its verdict; it does
 *    not re-select (a selection that moved on 2024 would make 2024 a second fit season).
 * 5. Season spread: the selected config per fit and calibrate season, F1 / recall /
 *    precision / event count each, and the max − min of F1 (11 §4.6 "re-run per season").
 * 6. ε_geo (exemption): the GEO ε axis on 2025, DS-1 + DS-4 rows, base = the selected
 *    config (or the baseline when nothing was selected, so the sweep still informs).
 *    Reported apart from the test season and marked as carrying no touch-once guarantee.
 * 7. Test (touch-once): only when the caller says the touch is authorised; the selected
 *    config only, DS-1 rows only.
 *
 * Every split reports every view (scope × stratum): the per-source numbers sit next to
 * the pooled ones by construction.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { ClusteringParams } from '../clustering/clustering-params.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import { replaySeason } from './fit-clustering.js';
import {
  cellConfig,
  cellParams,
  geoParams,
  gridCells,
  sliceShape,
  type FitGridAxes,
  type GridCell,
} from './fit-grid.js';
import {
  allViews,
  evaluateSeason,
  poolEvaluations,
  POOLED,
  SCOPE_ALL,
  SCOPE_ATTACH_ONLY,
  verdictOf,
  viewKey,
  viewOf,
  type MetricView,
  type SeasonEvaluation,
  type Verdict,
} from './fit-metrics.js';
import type { FitParams } from './fit-params.js';
import type { FitDetection, LabelJoinSummary, LabelPerimeter } from './label-join.js';
import { selectPlateau, type PlateauResult } from './plateau.js';
import { buildSeasonFrame, seasonOf, type SeasonFrame } from './season-frame.js';

export interface FitRunInput {
  /** DS-1 rows, every season. */
  readonly detections: readonly FitDetection[];
  /** DS-4 rows (GEO, 2025); empty when there is no DS-4. */
  readonly geoDetections: readonly FitDetection[];
  /** DS-3 perimeters, every layer. */
  readonly perimeters: readonly LabelPerimeter[];
  readonly params: VersionedConfig<FitParams>;
  readonly grid: VersionedConfig<FitGridAxes>;
  /** The live parameters: the grid's base, and the ε the label join buffers with. */
  readonly baseline: VersionedConfig<ClusteringParams>;
  /** The caller has decided the touch-once lock allows a test-season run. */
  readonly touchTestSeason: boolean;
  /** Run the ε_geo sweep (DS-4 present and checked, or synthetic). */
  readonly runEpsGeo: boolean;
  readonly progress?: (note: { readonly stage: string; readonly detail: string }) => void;
}

export interface SeasonSummary {
  readonly season: number;
  readonly detections: number;
  readonly sources: readonly SourceId[];
  readonly labels: LabelJoinSummary;
  readonly fires: number;
  readonly hardNegativePairs: number;
}

export interface NamedView {
  readonly key: string;
  readonly view: MetricView;
}

export interface SplitResult {
  readonly seasons: readonly number[];
  readonly eventCount: number;
  readonly verdict: Verdict;
  readonly views: readonly NamedView[];
}

export interface CellResult {
  readonly cell: GridCell;
  readonly configDigest: string;
  readonly eventCount: number;
  readonly pooledF1: number | null;
  readonly verdict: Verdict;
  /** `all|pooled`, `all|<bottom stratum>`, and `source:<id>|pooled` for every source. */
  readonly keyViews: readonly NamedView[];
}

export interface SeasonSpreadRow {
  readonly season: number;
  readonly eventCount: number;
  readonly pairwiseF1: number | null;
  readonly pairwiseRecall: number | null;
  readonly pairwisePrecision: number | null;
}

export interface EpsGeoRow {
  readonly epsGeoKm: number;
  readonly configDigest: string;
  readonly eventCount: number;
  readonly views: readonly NamedView[];
}

export type EpsGeoResult =
  | { readonly ran: false; readonly reason: string }
  | {
      readonly ran: true;
      readonly exemption: 'eps_geo_fitted_on_test_season';
      readonly season: number;
      readonly baseCellId: string | null;
      readonly rows: readonly EpsGeoRow[];
    };

export type TestResult =
  | { readonly touched: false; readonly reason: string }
  | { readonly touched: true; readonly split: SplitResult };

export interface FitRunResult {
  readonly seasons: readonly SeasonSummary[];
  readonly fitSeasons: readonly number[];
  readonly cells: readonly CellResult[];
  readonly plateau: PlateauResult;
  readonly selected: {
    readonly cell: GridCell;
    readonly params: ClusteringParams;
    readonly configDigest: string;
    readonly fit: SplitResult;
  } | null;
  readonly calibrate: SplitResult | { readonly skipped: string };
  readonly seasonSpread: {
    readonly rows: readonly SeasonSpreadRow[];
    readonly f1Spread: number | null;
  } | null;
  readonly epsGeo: EpsGeoResult;
  readonly test: TestResult;
}

export function runFit(input: FitRunInput): FitRunResult {
  const params = input.params.values;
  const base = input.baseline.values;
  const note = input.progress ?? ((): void => undefined);

  const frames = new Map<number, SeasonFrame>();
  const frameOf = (season: number, rows: readonly FitDetection[]): SeasonFrame =>
    buildSeasonFrame(season, rows, input.perimeters, params, base);
  const seasonsIn = (rows: readonly FitDetection[]): number[] =>
    [...new Set(rows.map((d) => seasonOf(d.acqTsIso)))].sort((a, b) => a - b);
  const present = seasonsIn(input.detections);
  const testSeasons = new Set(params.splits.test);
  // A test-season frame is built only on an authorised touch (step 7); building it here
  // would put 2025 labels into the report before the flag was read.
  for (const season of present) {
    if (testSeasons.has(season)) continue;
    frames.set(season, frameOf(season, input.detections));
  }
  const fitSeasons = params.splits.fit.filter((s) => frames.has(s));
  const calibrateSeasons = params.splits.calibrate.filter((s) => frames.has(s));

  const evaluate = (
    frame: SeasonFrame,
    config: VersionedConfig<ClusteringParams>,
  ): SeasonEvaluation =>
    evaluateSeason(frame, replaySeason(frame, config, params.replayBatchMinutes), params);
  const splitOver = (
    seasons: readonly number[],
    config: VersionedConfig<ClusteringParams>,
    source: ReadonlyMap<number, SeasonFrame>,
  ): { split: SplitResult; perSeason: SeasonEvaluation[] } => {
    const perSeason = seasons.map((s) => evaluate(source.get(s) as SeasonFrame, config));
    const pooled = poolEvaluations(perSeason);
    return {
      split: {
        seasons,
        eventCount: pooled.eventCount,
        verdict: verdictOf(pooled.tallies, params),
        views: allViews(pooled.tallies),
      },
      perSeason,
    };
  };

  // ── 2. Grid ────────────────────────────────────────────────────────────────────────
  const cells = gridCells(input.grid.values);
  const cellResults: CellResult[] = cells.map((cell, n) => {
    note({ stage: 'grid', detail: `${String(n + 1)}/${String(cells.length)} ${cell.id}` });
    const config = cellConfig(cellParams(cell, base, input.grid.values));
    const pooled = poolEvaluations(
      fitSeasons.map((s) => evaluate(frames.get(s) as SeasonFrame, config)),
    );
    const pooledAll = viewOf(pooled.tallies.get(viewKey(SCOPE_ALL, POOLED)));
    const keys = [
      viewKey(SCOPE_ALL, POOLED),
      viewKey(SCOPE_ALL, params.bottomStratumId),
      ...[...pooled.tallies.keys()]
        .filter((k) => k.startsWith('source:') && k.endsWith(`|${POOLED}`))
        .sort(),
    ];
    return {
      cell,
      configDigest: config.digest,
      eventCount: pooled.eventCount,
      pooledF1: pooledAll.pairwiseF1,
      verdict: verdictOf(pooled.tallies, params),
      keyViews: keys.map((key) => ({ key, view: viewOf(pooled.tallies.get(key)) })),
    };
  });

  // ── 3. Plateau ─────────────────────────────────────────────────────────────────────
  const plateau = selectPlateau(
    cellResults.map((r) => ({
      cell: r.cell,
      eventCount: r.eventCount,
      f1: r.pooledF1,
      meetsTargets: r.verdict.pass,
    })),
    {
      modis_fixed: sliceShape('modis_fixed', input.grid.values),
      modis_footprint: sliceShape('modis_footprint', input.grid.values),
    },
    params.plateau,
  );
  const chosen =
    plateau.selected === null ? undefined : cells.find((c) => c.id === plateau.selected?.cellId);

  let selected: FitRunResult['selected'] = null;
  let calibrate: FitRunResult['calibrate'] = { skipped: 'no acceptable configuration' };
  let seasonSpread: FitRunResult['seasonSpread'] = null;
  let selectedConfig: VersionedConfig<ClusteringParams> | null = null;
  if (chosen !== undefined) {
    const chosenParams = cellParams(chosen, base, input.grid.values);
    selectedConfig = cellConfig(chosenParams);
    const fit = splitOver(fitSeasons, selectedConfig, frames);
    selected = {
      cell: chosen,
      params: chosenParams,
      configDigest: selectedConfig.digest,
      fit: fit.split,
    };

    // ── 4. Calibrate ───────────────────────────────────────────────────────────────
    note({ stage: 'calibrate', detail: calibrateSeasons.join(',') || 'none' });
    let calibrationPerSeason: SeasonEvaluation[] = [];
    if (calibrateSeasons.length === 0) {
      calibrate = { skipped: 'no calibration-season data' };
    } else {
      const run = splitOver(calibrateSeasons, selectedConfig, frames);
      calibrate = run.split;
      calibrationPerSeason = run.perSeason;
    }

    // ── 5. Season spread ───────────────────────────────────────────────────────────
    const rows = [...fit.perSeason, ...calibrationPerSeason].map((e) => {
      const v = viewOf(e.tallies.get(viewKey(SCOPE_ALL, POOLED)));
      return {
        season: e.season,
        eventCount: e.eventCount,
        pairwiseF1: v.pairwiseF1,
        pairwiseRecall: v.pairwiseRecall.rate,
        pairwisePrecision: v.pairwisePrecision.rate,
      };
    });
    const f1s = rows.flatMap((r) => (r.pairwiseF1 === null ? [] : [r.pairwiseF1]));
    seasonSpread = {
      rows,
      f1Spread: f1s.length === 0 ? null : Math.max(...f1s) - Math.min(...f1s),
    };
  }

  // ── 6. ε_geo exemption ─────────────────────────────────────────────────────────────
  const geoSeason = params.splits.test[0];
  let epsGeo: EpsGeoResult;
  if (!input.runEpsGeo) {
    epsGeo = { ran: false, reason: 'DS-4 is not checked (DATASETS.md)' };
  } else if (geoSeason === undefined) {
    epsGeo = { ran: false, reason: 'no test season is configured' };
  } else if (!input.geoDetections.some((d) => seasonOf(d.acqTsIso) === geoSeason)) {
    epsGeo = { ran: false, reason: `no DS-4 rows in ${String(geoSeason)}` };
  } else {
    note({ stage: 'eps_geo', detail: String(geoSeason) });
    const frame = frameOf(geoSeason, [...input.detections, ...input.geoDetections]);
    const geoBase = selectedConfig?.values ?? base;
    const rows: EpsGeoRow[] = input.grid.values.epsGeoKm.map((km) => {
      const config = cellConfig(geoParams(km, geoBase));
      const evaluation = evaluate(frame, config);
      return {
        epsGeoKm: km,
        configDigest: config.digest,
        eventCount: evaluation.eventCount,
        views: allViews(evaluation.tallies).filter(
          ({ key }) =>
            key.startsWith(`${SCOPE_ATTACH_ONLY}|`) ||
            key.startsWith('source:lsasaf:') ||
            key.startsWith(`${SCOPE_ALL}|`),
        ),
      };
    });
    epsGeo = {
      ran: true,
      exemption: 'eps_geo_fitted_on_test_season',
      season: geoSeason,
      baseCellId: chosen?.id ?? null,
      rows,
    };
  }

  // ── 7. Test season ─────────────────────────────────────────────────────────────────
  let test: TestResult;
  const testPresent = params.splits.test.filter((s) => present.includes(s));
  if (!input.touchTestSeason) {
    test = { touched: false, reason: 'not requested (--touch-test-season)' };
  } else if (selectedConfig === null) {
    test = { touched: false, reason: 'no configuration was selected' };
  } else if (testPresent.length === 0) {
    test = { touched: false, reason: 'no test-season data' };
  } else {
    note({ stage: 'test', detail: testPresent.join(',') });
    const testFrames = new Map(testPresent.map((s) => [s, frameOf(s, input.detections)]));
    for (const [s, f] of testFrames) frames.set(s, f);
    test = { touched: true, split: splitOver(testPresent, selectedConfig, testFrames).split };
  }

  const seasons: SeasonSummary[] = [...frames.values()]
    .sort((a, b) => a.season - b.season)
    .map((f) => ({
      season: f.season,
      detections: f.detections.length,
      sources: f.sources,
      labels: f.labels,
      fires: f.fires.length,
      hardNegativePairs: f.hardNegatives.a.length,
    }));

  return {
    seasons,
    fitSeasons,
    cells: cellResults,
    plateau,
    selected,
    calibrate,
    seasonSpread,
    epsGeo,
    test,
  };
}

/** Version of the candidate the fit writes. Never `CLUSTERING_PARAMS` until a human wires it. */
export const CANDIDATE_VERSION = 'clustering_params_v2';

export function candidateConfig(params: ClusteringParams): VersionedConfig<ClusteringParams> {
  return defineConfig('clustering_params', CANDIDATE_VERSION, params);
}
