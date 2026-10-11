/**
 * The clustering parameter fit as one command (TASKS D7; GATES §2; ADR-002 D5).
 *
 *   pnpm fit --input=data/fit --out=reports/fit
 *   pnpm fit --input=data/fit --out=reports/fit --touch-test-season
 *   pnpm fit --input=fixtures/fit --out=/tmp/fit --synthetic
 *
 * Reads the input directory (`firms/<product>/<year>/*.csv`, `effis/modis.ba.poly.<year>.geojson`,
 * optional `geo/detections.json` — see `core/fit/fit-input.ts`), sweeps the grid over the
 * fit seasons, picks the plateau centre, checks it on the calibration season, and writes
 * `fit-report.json`, `fit-report.md` and — when a configuration was selected — the
 * unwired candidate `clustering-params-v2.candidate.json` into `--out`.
 *
 * Refusals (exit 2), all before any clustering:
 *
 * - DS-1 or DS-3 has no `--check` date in `docs/data/DATASETS.md` (23 E1) and `--synthetic`
 *   was not given. `--datasets=` points at another register.
 * - `--touch-test-season` over data the ledger says was already touched. The ledger is
 *   `<input>/fit-test-season-ledger.json` (synthetic runs: `<out>/…`, so a synthetic run
 *   never arms the real lock); `--ledger=` overrides.
 *
 * The ε_geo sweep runs when DS-4 is checked or the run is synthetic, and is skipped with
 * the reason recorded otherwise.
 *
 * Exit codes: 0 — written (whatever the verdict: a failing fit is a result, not an error);
 * 1 — the run failed on data or I/O; 2 — misconfiguration or a refusal.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readFitInputDir,
  readJsonIfPresent,
  writeTextAtomic,
} from '../adapters/fit/fit-input-dir.js';
import { CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { readiness, type DatasetStatus } from '../core/fit/dataset-readiness.js';
import { parseEffisPerimeters } from '../core/fit/effis-perimeters.js';
import { FIT_GRID } from '../core/fit/fit-grid.js';
import {
  effisLayerYear,
  ingestFirmsCsv,
  parseGeoDetections,
  sourceOfProduct,
} from '../core/fit/fit-input.js';
import { FIT_PARAMS } from '../core/fit/fit-params.js';
import {
  CANDIDATE_FILE,
  candidateFile,
  fitReportJson,
  fitReportMarkdown,
  inputManifest,
} from '../core/fit/fit-report.js';
import { runFit } from '../core/fit/fit-run.js';
import type { FitDetection, LabelPerimeter } from '../core/fit/label-join.js';
import {
  EMPTY_LEDGER,
  decideTestTouch,
  parseLedger,
  recordTouch,
  testSeasonKey,
  type TestTouch,
} from '../core/fit/test-season.js';
import type { DetectionUidFn } from '../core/ports/firms-client.js';
import { ConfigError } from './config.js';
import type { ProcessLog } from './logging.js';

export const LEDGER_FILE = 'fit-test-season-ledger.json';
export const REPORT_JSON = 'fit-report.json';
export const REPORT_MD = 'fit-report.md';

/** The repo's dataset register; `dist/app` and `src/app` sit at the same depth. */
const DEFAULT_DATASETS = fileURLToPath(new URL('../../../docs/data/DATASETS.md', import.meta.url));

export interface FitArgs {
  readonly inputDir: string;
  readonly outDir: string;
  readonly synthetic: boolean;
  readonly touchTestSeason: boolean;
  readonly datasetsPath: string;
  readonly ledgerPath: string;
}

export function parseFitArgs(argv: readonly string[], cwd: string): FitArgs {
  let input: string | null = null;
  let out: string | null = null;
  let datasets: string | null = null;
  let ledger: string | null = null;
  let synthetic = false;
  let touchTestSeason = false;
  const value = (arg: string, name: string): string => {
    const v = arg.slice(name.length + 3);
    if (v === '') throw new ConfigError(`--${name}= needs a value`);
    return v;
  };
  for (const arg of argv) {
    if (arg === '--synthetic') synthetic = true;
    else if (arg === '--touch-test-season') touchTestSeason = true;
    else if (arg.startsWith('--input=')) input = value(arg, 'input');
    else if (arg.startsWith('--out=')) out = value(arg, 'out');
    else if (arg.startsWith('--datasets=')) datasets = value(arg, 'datasets');
    else if (arg.startsWith('--ledger=')) ledger = value(arg, 'ledger');
    else throw new ConfigError(`unknown argument ${arg}`);
  }
  if (input === null) throw new ConfigError('--input=<dir> is required');
  if (out === null) throw new ConfigError('--out=<dir> is required');
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
  const inputDir = abs(input);
  const outDir = abs(out);
  return {
    inputDir,
    outDir,
    synthetic,
    touchTestSeason,
    datasetsPath: datasets === null ? DEFAULT_DATASETS : abs(datasets),
    ledgerPath: ledger === null ? join(synthetic ? outDir : inputDir, LEDGER_FILE) : abs(ledger),
  };
}

export interface FitCliDeps {
  readonly log: ProcessLog;
  readonly nowIso: () => string;
  readonly detectionUid: DetectionUidFn;
  readonly cwd: string;
}

function describeDatasets(datasets: readonly DatasetStatus[]): string {
  return datasets
    .filter((d) => d.id !== 'DS-4' && d.problem !== null)
    .map((d) => `${d.id}: ${d.problem ?? ''}`)
    .join(', ');
}

export async function runFitCli(argv: readonly string[], deps: FitCliDeps): Promise<number> {
  const args = parseFitArgs(argv, deps.cwd);
  const { log } = deps;

  // 1. The data must be checked before any of it is read (23 E1).
  let datasets: readonly DatasetStatus[] | 'skipped (--synthetic)' = 'skipped (--synthetic)';
  let geoReady = false;
  if (!args.synthetic) {
    const register = readiness(await readFile(args.datasetsPath, 'utf8'));
    if (!register.ready) {
      throw new ConfigError(
        `refusing to fit: DS-1 and DS-3 need a dated --check row in ${args.datasetsPath} ` +
          `(${describeDatasets(register.datasets)}); pass --synthetic for a machinery run`,
      );
    }
    datasets = register.datasets;
    geoReady = register.geoReady;
  }

  log.note({
    starting: {
      fit: { input: args.inputDir, out: args.outDir, mode: args.synthetic ? 'synthetic' : 'real' },
      fit_config: FIT_PARAMS.version,
      fit_config_digest: FIT_PARAMS.digest,
      grid_config: FIT_GRID.version,
      grid_config_digest: FIT_GRID.digest,
      baseline_config: CLUSTERING_PARAMS.version,
      baseline_config_digest: CLUSTERING_PARAMS.digest,
    },
  });

  // 2. Inputs.
  const dir = await readFitInputDir(args.inputDir);
  const intake: Record<string, number> = {
    ds1_files: 0,
    ds1_files_unknown_product: 0,
    ds1_rows: 0,
    ds1_rows_rejected: 0,
    ds1_rows_duplicate: 0,
    ds3_files: 0,
    ds3_files_unrecognised: 0,
    ds3_perimeters: 0,
    ds4_rows: 0,
  };
  const bump = (key: string, by = 1): void => {
    intake[key] = (intake[key] ?? 0) + by;
  };
  const detections: FitDetection[] = [];
  const seen = new Set<string>();
  const ds1Files = [];
  for (const file of dir.firms) {
    const source = sourceOfProduct(file.product);
    if (source === null) {
      bump('ds1_files_unknown_product');
      continue;
    }
    const counts = ingestFirmsCsv(file.text, source, deps.detectionUid, seen, detections);
    bump('ds1_files');
    bump('ds1_rows', counts.rows - counts.duplicates);
    bump('ds1_rows_rejected', counts.rejected);
    bump('ds1_rows_duplicate', counts.duplicates);
    ds1Files.push({ path: file.path, sha256: file.sha256 });
  }
  const perimeters: LabelPerimeter[] = [];
  const ds3Files = [];
  for (const file of dir.effis) {
    const year = effisLayerYear(file.fileName);
    if (year === null) {
      bump('ds3_files_unrecognised');
      continue;
    }
    let collection: unknown;
    try {
      collection = JSON.parse(file.text) as unknown;
    } catch (error) {
      throw new Error(`${file.path} is not JSON: ${(error as Error).message}`, { cause: error });
    }
    const parsed = parseEffisPerimeters(String(year), collection);
    perimeters.push(...parsed.perimeters);
    bump('ds3_files');
    bump('ds3_perimeters', parsed.perimeters.length);
    for (const [reason, n] of Object.entries(parsed.rejected)) bump(`ds3_rejected_${reason}`, n);
    ds3Files.push({ path: file.path, sha256: file.sha256 });
  }
  const ds4Files = dir.geo === null ? [] : [{ path: dir.geo.path, sha256: dir.geo.sha256 }];
  const geoDetections =
    dir.geo === null
      ? []
      : parseGeoDetections(JSON.parse(dir.geo.text) as unknown, deps.detectionUid);
  bump('ds4_rows', geoDetections.length);

  // 3. The touch-once lock.
  const ledgerKey = testSeasonKey(ds1Files, ds3Files);
  const rawLedger = await readJsonIfPresent(args.ledgerPath);
  const ledger = rawLedger === null ? EMPTY_LEDGER : parseLedger(rawLedger);
  const decision = decideTestTouch(args.touchTestSeason, ledger, ledgerKey);
  if (decision.touch === false && decision.reason === 'already_touched') {
    throw new ConfigError(
      `refusing to touch the test season again: data ${ledgerKey} was touched at ` +
        `${decision.previous.touchedAt} (${args.ledgerPath})`,
    );
  }

  // 4. The fit.
  const result = runFit({
    detections,
    geoDetections,
    perimeters,
    params: FIT_PARAMS,
    grid: FIT_GRID,
    baseline: CLUSTERING_PARAMS,
    touchTestSeason: decision.touch,
    runEpsGeo: args.synthetic || geoReady,
    progress: (note) => {
      log.note({ fit_progress: note });
    },
  });

  // 5. Outputs: the ledger first, so a crash after it never leaves an unrecorded touch.
  const generatedAt = deps.nowIso();
  const candidate = candidateFile(result);
  let recorded: TestTouch | null = null;
  if (result.test.touched && result.selected !== null && candidate !== null) {
    recorded = {
      key: ledgerKey,
      touchedAt: generatedAt,
      selectedCellId: result.selected.cell.id,
      candidateDigest: candidate.digest,
    };
    await writeTextAtomic(
      args.ledgerPath,
      `${JSON.stringify(recordTouch(ledger, recorded), null, 2)}\n`,
    );
  }

  const reportInput = {
    generatedAt,
    mode: args.synthetic ? ('synthetic' as const) : ('real' as const),
    datasets,
    inputs: {
      'DS-1': inputManifest(ds1Files),
      'DS-3': inputManifest(ds3Files),
      'DS-4': inputManifest(ds4Files),
    },
    intake,
    params: FIT_PARAMS,
    grid: FIT_GRID,
    baseline: CLUSTERING_PARAMS,
    testSeason: { requested: args.touchTestSeason, ledgerKey, decision, recorded },
    result,
  };
  await writeTextAtomic(join(args.outDir, REPORT_JSON), fitReportJson(reportInput));
  await writeTextAtomic(join(args.outDir, REPORT_MD), fitReportMarkdown(reportInput));
  if (candidate !== null) {
    await writeTextAtomic(
      join(args.outDir, CANDIDATE_FILE),
      `${JSON.stringify(JSON.parse(canonicalJson(candidate)), null, 2)}\n`,
    );
  }

  log.line(
    canonicalJson({
      clustering_fit: {
        mode: reportInput.mode,
        cells: result.cells.length,
        selected: result.selected?.cell.id ?? null,
        fit_pass: result.selected?.fit.verdict.pass ?? null,
        calibrate_pass: 'verdict' in result.calibrate ? result.calibrate.verdict.pass : null,
        test_touched: result.test.touched,
        eps_geo: result.epsGeo.ran,
        candidate: candidate === null ? null : CANDIDATE_FILE,
        out: args.outDir,
      },
    }),
  );
  return 0;
}
