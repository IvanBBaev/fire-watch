/**
 * The constellation replay as one command (GATES §3 L-14).
 *
 *   pnpm constellation-replay --input=data/fit --out=reports/constellation-2027
 *   pnpm constellation-replay --input=fixtures/fit --out=/tmp/l14 --synthetic
 *
 * Reads the same input directory as `pnpm fit` (`loadFitInputs`), restricts it to the
 * constellation (`--constellation=`, default `constellation_2027_v1`), judges the
 * incumbent `CLUSTERING_PARAMS` against GATES §2 on the fit and calibrate seasons, runs
 * the constellation-specific re-fit, and writes `constellation-replay.json`,
 * `constellation-replay.md`, and the re-fit's own fit report (plus its unwired candidate,
 * when one was selected) under `<out>/refit/`.
 *
 * The test season is never clustered: there is no `--touch-test-season` here, and the
 * fit's touch-once ledger is neither read nor written.
 *
 * Refusals (exit 2), all before any clustering: DS-1 or DS-3 without a `--check` date in
 * `docs/data/DATASETS.md` unless `--synthetic`; an unknown `--constellation`.
 *
 * Exit codes: 0 — written (whatever the verdict); 1 — the run failed on data or I/O;
 * 2 — misconfiguration or a refusal.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeTextAtomic } from '../adapters/fit/fit-input-dir.js';
import { CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  CONSTELLATION_2027,
  CONSTELLATIONS,
  constellationByVersion,
} from '../core/fit/constellation.js';
import {
  constellationReportJson,
  constellationReportMarkdown,
} from '../core/fit/constellation-report.js';
import { runConstellationReplay } from '../core/fit/constellation-replay.js';
import { readiness, type DatasetStatus } from '../core/fit/dataset-readiness.js';
import { FIT_GRID } from '../core/fit/fit-grid.js';
import { FIT_PARAMS } from '../core/fit/fit-params.js';
import {
  CANDIDATE_FILE,
  candidateFile,
  fitReportJson,
  fitReportMarkdown,
  inputManifest,
} from '../core/fit/fit-report.js';
import { testSeasonKey } from '../core/fit/test-season.js';
import type { DetectionUidFn } from '../core/ports/firms-client.js';
import { ConfigError } from './config.js';
import { REPORT_JSON, REPORT_MD, describeDatasets, loadFitInputs } from './fit-cli-run.js';
import type { ProcessLog } from './logging.js';

export const CONSTELLATION_REPORT_JSON = 'constellation-replay.json';
export const CONSTELLATION_REPORT_MD = 'constellation-replay.md';
export const REFIT_DIR = 'refit';

const DEFAULT_DATASETS = fileURLToPath(new URL('../../../docs/data/DATASETS.md', import.meta.url));

export interface ConstellationReplayArgs {
  readonly inputDir: string;
  readonly outDir: string;
  readonly synthetic: boolean;
  readonly datasetsPath: string;
  readonly constellation: string;
}

export function parseConstellationReplayArgs(
  argv: readonly string[],
  cwd: string,
): ConstellationReplayArgs {
  let input: string | null = null;
  let out: string | null = null;
  let datasets: string | null = null;
  let constellation = CONSTELLATION_2027.version;
  let synthetic = false;
  const value = (arg: string, name: string): string => {
    const v = arg.slice(name.length + 3);
    if (v === '') throw new ConfigError(`--${name}= needs a value`);
    return v;
  };
  for (const arg of argv) {
    if (arg === '--synthetic') synthetic = true;
    else if (arg.startsWith('--input=')) input = value(arg, 'input');
    else if (arg.startsWith('--out=')) out = value(arg, 'out');
    else if (arg.startsWith('--datasets=')) datasets = value(arg, 'datasets');
    else if (arg.startsWith('--constellation=')) constellation = value(arg, 'constellation');
    else throw new ConfigError(`unknown argument ${arg}`);
  }
  if (input === null) throw new ConfigError('--input=<dir> is required');
  if (out === null) throw new ConfigError('--out=<dir> is required');
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
  return {
    inputDir: abs(input),
    outDir: abs(out),
    synthetic,
    datasetsPath: datasets === null ? DEFAULT_DATASETS : abs(datasets),
    constellation,
  };
}

export interface ConstellationReplayCliDeps {
  readonly log: ProcessLog;
  readonly nowIso: () => string;
  readonly detectionUid: DetectionUidFn;
  readonly cwd: string;
}

export async function runConstellationReplayCli(
  argv: readonly string[],
  deps: ConstellationReplayCliDeps,
): Promise<number> {
  const args = parseConstellationReplayArgs(argv, deps.cwd);
  const { log } = deps;

  const constellation = constellationByVersion(args.constellation);
  if (constellation === null) {
    throw new ConfigError(
      `unknown constellation ${args.constellation}; known: ${CONSTELLATIONS.map((c) => c.version).join(', ')}`,
    );
  }

  // 1. The data must be checked before any of it is read (23 E1).
  let datasets: readonly DatasetStatus[] | 'skipped (--synthetic)' = 'skipped (--synthetic)';
  let geoReady = false;
  if (!args.synthetic) {
    const register = readiness(await readFile(args.datasetsPath, 'utf8'));
    if (!register.ready) {
      throw new ConfigError(
        `refusing to replay: DS-1 and DS-3 need a dated --check row in ${args.datasetsPath} ` +
          `(${describeDatasets(register.datasets)}); pass --synthetic for a machinery run`,
      );
    }
    datasets = register.datasets;
    geoReady = register.geoReady;
  }

  log.note({
    starting: {
      constellation_replay: {
        input: args.inputDir,
        out: args.outDir,
        mode: args.synthetic ? 'synthetic' : 'real',
      },
      constellation: constellation.version,
      constellation_digest: constellation.digest,
      fit_config: FIT_PARAMS.version,
      grid_config: FIT_GRID.version,
      incumbent_config: CLUSTERING_PARAMS.version,
      incumbent_config_digest: CLUSTERING_PARAMS.digest,
    },
  });

  // 2. Inputs, read exactly as the fit reads them.
  const inputs = await loadFitInputs(args.inputDir, deps.detectionUid);

  // 3. The replay.
  const result = runConstellationReplay({
    detections: inputs.detections,
    geoDetections: inputs.geoDetections,
    perimeters: inputs.perimeters,
    constellation,
    params: FIT_PARAMS,
    grid: FIT_GRID,
    incumbent: CLUSTERING_PARAMS,
    runEpsGeo: args.synthetic || geoReady,
    progress: (note) => {
      log.note({ constellation_replay_progress: note });
    },
  });

  // 4. Outputs.
  const generatedAt = deps.nowIso();
  const mode = args.synthetic ? ('synthetic' as const) : ('real' as const);
  const manifests = {
    'DS-1': inputManifest(inputs.ds1Files),
    'DS-3': inputManifest(inputs.ds3Files),
    'DS-4': inputManifest(inputs.ds4Files),
  };
  const refitDir = join(args.outDir, REFIT_DIR);
  const refitReport = {
    generatedAt,
    mode,
    datasets,
    inputs: manifests,
    intake: inputs.intake,
    params: FIT_PARAMS,
    grid: FIT_GRID,
    baseline: CLUSTERING_PARAMS,
    testSeason: {
      requested: false,
      ledgerKey: testSeasonKey(inputs.ds1Files, inputs.ds3Files),
      decision: { touch: false as const, reason: 'not_requested' as const },
      recorded: null,
    },
    result: result.refit,
  };
  await writeTextAtomic(join(refitDir, REPORT_JSON), fitReportJson(refitReport));
  await writeTextAtomic(join(refitDir, REPORT_MD), fitReportMarkdown(refitReport));
  const candidate = candidateFile(result.refit);
  if (candidate !== null) {
    await writeTextAtomic(
      join(refitDir, CANDIDATE_FILE),
      `${JSON.stringify(JSON.parse(canonicalJson(candidate)), null, 2)}\n`,
    );
  }

  const report = {
    generatedAt,
    mode,
    datasets,
    inputs: manifests,
    intake: inputs.intake,
    constellation,
    params: FIT_PARAMS,
    grid: FIT_GRID,
    incumbent: CLUSTERING_PARAMS,
    refitDir: REFIT_DIR,
    result,
  };
  await writeTextAtomic(
    join(args.outDir, CONSTELLATION_REPORT_JSON),
    constellationReportJson(report),
  );
  await writeTextAtomic(
    join(args.outDir, CONSTELLATION_REPORT_MD),
    constellationReportMarkdown(report),
  );

  log.line(
    canonicalJson({
      constellation_replay: {
        mode,
        constellation: constellation.version,
        outcome: result.verdict.outcome,
        refit_required: result.verdict.refitRequired,
        missing_live_sources: result.coverage.missing,
        refit_selected: result.refit.selected?.cell.id ?? null,
        out: args.outDir,
      },
    }),
  );
  return 0;
}
