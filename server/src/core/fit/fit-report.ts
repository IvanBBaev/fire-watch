/**
 * The fit report — JSON for machines, Markdown for the founder — and the candidate
 * parameter file (TASKS D7; GATES §2 "a fit report names the entry, never 'the
 * backfill'").
 *
 * The report names its inputs by register id (DS-1, DS-3, DS-4) with the file count and a
 * digest over the input files' sha256s, every config it ran under by version and digest,
 * every threshold, every rule the spec left open (`FIT_DECISIONS`), the test-season touch
 * and the ε_geo exemption — so it can be read without opening the code.
 *
 * The candidate is `clustering_params_v2`, status `candidate`, `active: false`. Writing
 * it changes nothing: `CLUSTERING_PARAMS` is still v1 until a human reviews the report and
 * wires the values in under ADR-002 D5's change rule.
 */

import type { ClusteringParams } from '../clustering/clustering-params.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { configDigest, type VersionedConfig } from '../config/versioned-config.js';
import type { DatasetStatus } from './dataset-readiness.js';
import type { FitGridAxes } from './fit-grid.js';
import type { MetricView } from './fit-metrics.js';
import type { FitParams } from './fit-params.js';
import { candidateConfig, type FitRunResult, type NamedView, type SplitResult } from './fit-run.js';
import type { InputFile, TestTouch, TouchDecision } from './test-season.js';

export const FIT_REPORT_VERSION = 'clustering_fit_report_v1';
export const CANDIDATE_FILE = 'clustering-params-v2.candidate.json';

/** Every open choice the spec left, as decided in code. Repeated verbatim in each report. */
export const FIT_DECISIONS: readonly string[] = [
  'Label join buffers with the baseline (v1) ε, not the candidate ε, so the labelled population is identical for every grid cell.',
  'Label join time window: [FIREDATE − 1 d, FINALDATE (or FIREDATE) + 3 d], inclusive; buffer max(ε_source, 1 km); perimeter holes ignored; a perimeter without AREA_HA is dropped.',
  'Season = UTC calendar year of acq_ts; each season is clustered on its own, so no pair, event or fire spans two seasons.',
  'SP rows have no available_at: the replay batches rows in 60-minute acq_ts windows, each made available at its window end.',
  'The fit replays the production clusterBatch engine, not offline DBSCAN.',
  'Size strata are half-open [min, max): exactly 50 ha is 50_500_ha, exactly 500 ha is ge_500_ha. Below 10 ha is reported, never gated, and is not part of "pooled".',
  'A hard-negative pair takes the stratum of the smaller fire (ties: lower fire id).',
  'Over-split: events holding ≥ 10 % of the fire’s labelled detections (share counted over all of them, unattached included); if none reaches 10 %, the number of distinct events; a fire in no event is counted separately as fires_without_event.',
  'Chimera: an event with ≥ 1 labelled member is judged; it is a chimera when ≥ 2 fires each hold ≥ 10 % of its labelled members; its stratum is the largest-share fire’s (ties: lower fire id).',
  'Timeline: the fire’s dominant event (most of its detections; ties: earliest started_at, then lowest id) must start within ± 12 h (inclusive) of the fire’s first labelled detection; a fire with no event is a miss.',
  'A detection in no event (GEO that attached nowhere) is separated from every other detection and is a singleton for ARI.',
  'Per-source scopes: a pair counts under source:<id> only when both ends are from that source; mixed pairs count under cross_source; attach_only is the GEO sources together.',
  'Gate verdict = all|pooled and all|10_50_ha both meet every threshold; an unmeasured value fails; per-source views are reported, not gated.',
  'Grid: ε_viirs × ε_modis × T_LINK swept jointly (150 configs × 4 fit seasons = 600 runs) instead of 11 §4.3’s staged sweep; MODIS has a fixed-ε slice and a footprint-rule slice; the active window is max(72 h, T_LINK).',
  'Plateau: acceptable = meets targets and every ±1 neighbour is within 10 % event count (relative to the cell) and 0.01 pooled F1; region = ±1-connected acceptable cells in one slice; width = largest all-acceptable L∞ box radius fully inside the grid; widest region by width, then size, then slice name, then smallest index; centre = max-inradius cell nearest the region’s index centroid, ties by smallest index; no acceptable cell = no candidate.',
  'Calibration (2024) runs the selected config once and reports its verdict; it never re-selects.',
  'The test season is clustered only with --touch-test-season and only once per DS-1/DS-3 identity (ledger); it runs DS-1 rows only.',
  'ε_geo is swept on 2025 (DS-1 + DS-4 rows) with the selected config as its base (baseline when none), reported apart from the test season, with no touch-once guarantee.',
];

export interface InputManifest {
  readonly files: number;
  /** Digest over the sorted `{path, sha256}` list; `null` when there are no files. */
  readonly digest: string | null;
}

export function inputManifest(files: readonly InputFile[]): InputManifest {
  if (files.length === 0) return { files: 0, digest: null };
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.length, digest: configDigest(sorted) };
}

export interface FitReportInput {
  readonly generatedAt: string;
  readonly mode: 'real' | 'synthetic';
  readonly datasets: readonly DatasetStatus[] | 'skipped (--synthetic)';
  readonly inputs: {
    readonly 'DS-1': InputManifest;
    readonly 'DS-3': InputManifest;
    readonly 'DS-4': InputManifest;
  };
  readonly intake: Readonly<Record<string, number>>;
  readonly params: VersionedConfig<FitParams>;
  readonly grid: VersionedConfig<FitGridAxes>;
  readonly baseline: VersionedConfig<ClusteringParams>;
  readonly testSeason: {
    readonly requested: boolean;
    readonly ledgerKey: string;
    readonly decision: TouchDecision;
    readonly recorded: TestTouch | null;
  };
  readonly result: FitRunResult;
}

export interface CandidateFile {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly status: 'candidate';
  readonly active: false;
  readonly note: string;
  readonly selectedCellId: string;
  readonly fitReportVersion: string;
  readonly values: ClusteringParams;
}

export function candidateFile(result: FitRunResult): CandidateFile | null {
  if (result.selected === null) return null;
  const config = candidateConfig(result.selected.params);
  return {
    name: config.name,
    version: config.version,
    digest: config.digest,
    status: 'candidate',
    active: false,
    note: 'Fit output. Not wired: CLUSTERING_PARAMS stays v1 until this is reviewed and adopted under ADR-002 D5.',
    selectedCellId: result.selected.cell.id,
    fitReportVersion: FIT_REPORT_VERSION,
    values: config.values,
  };
}

export function fitReportJson(input: FitReportInput): string {
  const candidate = candidateFile(input.result);
  const doc = {
    report: FIT_REPORT_VERSION,
    generatedAt: input.generatedAt,
    mode: input.mode,
    datasets: input.datasets,
    inputs: input.inputs,
    intake: input.intake,
    configs: {
      fit: { version: input.params.version, digest: input.params.digest },
      grid: { version: input.grid.version, digest: input.grid.digest },
      baseline: { version: input.baseline.version, digest: input.baseline.digest },
    },
    thresholds: input.params.values.thresholds,
    fitParams: input.params.values,
    gridAxes: input.grid.values,
    decisions: FIT_DECISIONS,
    testSeason: input.testSeason,
    candidate:
      candidate === null
        ? { written: false, reason: 'no acceptable configuration' }
        : {
            written: true,
            file: CANDIDATE_FILE,
            version: candidate.version,
            digest: candidate.digest,
            active: false,
          },
    result: input.result,
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(doc)), null, 2)}\n`;
}

const pct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(2)} %`);
const num = (v: number | null, digits = 3): string => (v === null ? '—' : v.toFixed(digits));

function viewRow(key: string, v: MetricView): string {
  const rate = (r: { numerator: number; denominator: number; rate: number | null }): string =>
    `${pct(r.rate)} (${String(r.numerator)}/${String(r.denominator)})`;
  return [
    '',
    `\`${key}\``,
    rate(v.pairwiseRecall),
    rate(v.pairwisePrecision),
    num(v.pairwiseF1),
    num(v.overSplitMean),
    num(v.overSplitP95.value, 0),
    String(v.firesWithoutEvent),
    rate(v.chimeraRate),
    rate(v.timelineAgreement),
    num(v.ari),
    '',
  ]
    .join(' | ')
    .trim();
}

function viewsTable(views: readonly NamedView[]): string[] {
  return [
    '| View | Recall | Precision (hard neg.) | F1 | Over-split mean | p95 | No event | Chimera | Timeline ±12 h | ARI |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...views.map(({ key, view }) => viewRow(key, view)),
  ];
}

function splitSection(title: string, split: SplitResult): string[] {
  return [
    `### ${title}`,
    '',
    `Seasons ${split.seasons.join(', ')} · events ${String(split.eventCount)} · verdict **${split.verdict.pass ? 'PASS' : 'FAIL'}**`,
    '',
    ...split.verdict.views.map(
      (v) =>
        `- \`${v.view}\`: ${v.checks
          .map(
            (c) =>
              `${c.metric} ${c.target} → ${c.met === null ? 'unmeasured' : c.met ? 'met' : 'missed'}`,
          )
          .join('; ')}`,
    ),
    '',
    ...viewsTable(split.views),
    '',
  ];
}

export function fitReportMarkdown(input: FitReportInput): string {
  const r = input.result;
  const candidate = candidateFile(r);
  const lines: string[] = [
    `# Clustering parameter fit — ${input.mode === 'synthetic' ? 'SYNTHETIC' : 'real data'}`,
    '',
    `Generated ${input.generatedAt} · report \`${FIT_REPORT_VERSION}\``,
    '',
    '## Inputs',
    '',
    '| Register id | Files | Input digest | `--check` |',
    '| --- | --- | --- | --- |',
    ...(['DS-1', 'DS-3', 'DS-4'] as const).map((id) => {
      const m = input.inputs[id];
      const status =
        input.datasets === 'skipped (--synthetic)'
          ? 'skipped (--synthetic)'
          : (input.datasets.find((d) => d.id === id)?.checkedOn ?? 'not checked');
      return `| ${id} | ${String(m.files)} | ${m.digest ?? '—'} | ${status} |`;
    }),
    '',
    `Intake: ${Object.entries(input.intake)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(' · ')}`,
    '',
    '## Configs',
    '',
    `- fit rules \`${input.params.version}\` \`${input.params.digest}\``,
    `- grid \`${input.grid.version}\` \`${input.grid.digest}\` — ${String(r.cells.length)} configs × ${String(r.fitSeasons.length)} fit seasons`,
    `- baseline \`${input.baseline.version}\` \`${input.baseline.digest}\``,
    '',
    '## Thresholds (GATES §2)',
    '',
    ...Object.entries(input.params.values.thresholds).map(([k, v]) => `- ${k}: ${String(v)}`),
    '',
    '## Seasons',
    '',
    '| Season | Detections | Labelled | Ambiguous | Unlabelled | Fires | Hard-negative pairs | Sources |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.seasons.map(
      (s) =>
        `| ${String(s.season)} | ${String(s.detections)} | ${String(s.labels.labeled)} | ${String(s.labels.ambiguous)} | ${String(s.labels.unlabeled)} | ${String(s.fires)} | ${String(s.hardNegativePairs)} | ${s.sources.join(', ')} |`,
    ),
    '',
    '## Selection (plateau rule)',
    '',
    `Acceptable cells: ${String(r.plateau.cells.filter((c) => c.acceptable).length)} of ${String(r.cells.length)} · regions: ${String(r.plateau.regions.length)}`,
    '',
    r.selected === null
      ? '**No acceptable configuration.** No candidate is written.'
      : `**Selected \`${r.selected.cell.id}\`** (config digest \`${r.selected.configDigest}\`), region of ${String(r.plateau.selected?.regionCells ?? 0)} cells, width ${String(r.plateau.selected?.width ?? 0)}.`,
    '',
  ];
  if (candidate !== null) {
    lines.push(
      `Candidate file \`${CANDIDATE_FILE}\`: \`${candidate.version}\` digest \`${candidate.digest}\`, status candidate, **not active**.`,
      '',
    );
  }
  lines.push('## Splits', '');
  if (r.selected !== null) lines.push(...splitSection('Fit (selected config)', r.selected.fit));
  if ('skipped' in r.calibrate)
    lines.push('### Calibrate', '', `Skipped: ${r.calibrate.skipped}.`, '');
  else lines.push(...splitSection('Calibrate', r.calibrate));
  if (r.seasonSpread !== null) {
    lines.push(
      '### Per-season spread (selected config)',
      '',
      '| Season | Events | F1 | Recall | Precision |',
      '| --- | --- | --- | --- | --- |',
      ...r.seasonSpread.rows.map(
        (s) =>
          `| ${String(s.season)} | ${String(s.eventCount)} | ${num(s.pairwiseF1)} | ${pct(s.pairwiseRecall)} | ${pct(s.pairwisePrecision)} |`,
      ),
      '',
      `F1 spread (max − min): ${num(r.seasonSpread.f1Spread)}`,
      '',
    );
  }
  lines.push('## Test season (touch-once)', '');
  lines.push(
    `Requested: ${input.testSeason.requested ? 'yes' : 'no'} · ledger key \`${input.testSeason.ledgerKey}\` · ${
      r.test.touched ? '**touched — recorded in the ledger**' : `not touched: ${r.test.reason}`
    }`,
    '',
  );
  if (r.test.touched) lines.push(...splitSection('Test', r.test.split));
  lines.push('## ε_geo (exemption — fitted on the test season, no touch-once guarantee)', '');
  if (!r.epsGeo.ran) {
    lines.push(`Not run: ${r.epsGeo.reason}.`, '');
  } else {
    lines.push(
      `Season ${String(r.epsGeo.season)}, base ${r.epsGeo.baseCellId === null ? 'baseline v1' : `\`${r.epsGeo.baseCellId}\``}.`,
      '',
    );
    for (const row of r.epsGeo.rows) {
      lines.push(
        `#### ε_geo = ${String(row.epsGeoKm)} km (digest \`${row.configDigest}\`, events ${String(row.eventCount)})`,
        '',
        ...viewsTable(row.views),
        '',
      );
    }
  }
  lines.push(
    '## Grid',
    '',
    '| Cell | Events | F1 | Meets targets | Stable | Acceptable | Inradius |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.cells.map((c, i) => {
      const j = r.plateau.cells[i];
      return `| \`${c.cell.id}\` | ${String(c.eventCount)} | ${num(c.pooledF1)} | ${c.verdict.pass ? 'yes' : 'no'} | ${j?.stable === true ? 'yes' : 'no'} | ${j?.acceptable === true ? 'yes' : 'no'} | ${j?.inradius === null || j === undefined ? '—' : String(j.inradius)} |`;
    }),
    '',
    '## Decisions the spec left open',
    '',
    ...FIT_DECISIONS.map((d) => `- ${d}`),
    '',
  );
  return lines.join('\n');
}
