/**
 * The constellation replay report (GATES §3 L-14) — JSON for machines, Markdown for the
 * founder. The re-fit half is written separately as an ordinary fit report under
 * `refit/` (`fit-report.ts`), so this report carries only its headline.
 */

import { LIVE_SOURCE_IDS } from '@fire-watch/contracts';

import type { ClusteringParams } from '../clustering/clustering-params.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { Constellation } from './constellation.js';
import type { ConstellationReplayResult, SplitCoverage } from './constellation-replay.js';
import type { DatasetStatus } from './dataset-readiness.js';
import type { FitGridAxes } from './fit-grid.js';
import type { FitParams } from './fit-params.js';
import { splitSection, type InputManifest } from './fit-report.js';

export const CONSTELLATION_REPORT_VERSION = 'constellation_replay_report_v1';

/** Every open choice L-14 left, as decided in code. Repeated verbatim in each report. */
export const CONSTELLATION_DECISIONS: readonly string[] = [
  'Acceptance judges the incumbent (live CLUSTERING_PARAMS) on the restricted stream with the GATES §2 verdict the fit uses: all|pooled and all|10_50_ha, every threshold, unmeasured fails.',
  'Acceptance covers the fit (2020–23) and calibrate (2024) seasons; the touch-once test season (2025) is never clustered by the replay.',
  'The constellation-specific re-fit is always computed (full D7 grid, plateau, calibrate, spread) so a miss arrives with its candidate; it is written under refit/ and never wired.',
  'Restriction removes rows of dropped sources from DS-1 and DS-4 and changes nothing else; GEO attach-only rows are kept unchanged.',
  'A live source with no rows in any acceptance season has no per-source metrics, so thresholds that hold without it are pass_unproven, not pass. So is a pass with one acceptance split missing.',
  'A threshold miss on any acceptance split with data is a fail and sets refit_required.',
  'The MODIS ε axes of the grid are inert on a stream without MODIS: their cells are duplicates, which the plateau rule tolerates.',
];

export interface ConstellationReportInput {
  readonly generatedAt: string;
  readonly mode: 'real' | 'synthetic';
  readonly datasets: readonly DatasetStatus[] | 'skipped (--synthetic)';
  readonly inputs: {
    readonly 'DS-1': InputManifest;
    readonly 'DS-3': InputManifest;
    readonly 'DS-4': InputManifest;
  };
  readonly intake: Readonly<Record<string, number>>;
  readonly constellation: VersionedConfig<Constellation>;
  readonly params: VersionedConfig<FitParams>;
  readonly grid: VersionedConfig<FitGridAxes>;
  readonly incumbent: VersionedConfig<ClusteringParams>;
  /** Relative path of the re-fit's own report directory. */
  readonly refitDir: string;
  readonly result: ConstellationReplayResult;
}

export function constellationReportJson(input: ConstellationReportInput): string {
  const r = input.result;
  const doc = {
    report: CONSTELLATION_REPORT_VERSION,
    gate: 'GATES §3 L-14',
    generatedAt: input.generatedAt,
    mode: input.mode,
    datasets: input.datasets,
    inputs: input.inputs,
    intake: input.intake,
    configs: {
      constellation: { version: input.constellation.version, digest: input.constellation.digest },
      fit: { version: input.params.version, digest: input.params.digest },
      grid: { version: input.grid.version, digest: input.grid.digest },
      incumbent: { version: input.incumbent.version, digest: input.incumbent.digest },
    },
    constellationValues: input.constellation.values,
    thresholds: input.params.values.thresholds,
    decisions: CONSTELLATION_DECISIONS,
    verdict: r.verdict,
    restriction: r.restriction,
    coverage: r.coverage,
    acceptance: r.acceptance,
    refit: {
      dir: input.refitDir,
      selected: r.refit.selected?.cell.id ?? null,
      selectedConfigDigest: r.refit.selected?.configDigest ?? null,
      fitPass: r.refit.selected?.fit.verdict.pass ?? null,
      calibratePass: 'verdict' in r.refit.calibrate ? r.refit.calibrate.verdict.pass : null,
      f1Spread: r.refit.seasonSpread?.f1Spread ?? null,
    },
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(doc)), null, 2)}\n`;
}

function coverageTable(
  fit: SplitCoverage,
  calibrate: SplitCoverage,
  input: ConstellationReportInput,
): string[] {
  const membership = input.constellation.values.membership;
  return [
    '| Source | Role | Fit rows | Calibrate rows |',
    '| --- | --- | --- | --- |',
    ...LIVE_SOURCE_IDS.map(
      (id) =>
        `| \`${id}\` | ${membership[id]} | ${String(fit.rowsBySource[id] ?? 0)} | ${String(calibrate.rowsBySource[id] ?? 0)} |`,
    ),
  ];
}

export function constellationReportMarkdown(input: ConstellationReportInput): string {
  const r = input.result;
  const c = input.constellation.values;
  const lines: string[] = [
    `# Constellation replay (GATES L-14) — ${input.mode === 'synthetic' ? 'SYNTHETIC' : 'real data'}`,
    '',
    `Generated ${input.generatedAt} · report \`${CONSTELLATION_REPORT_VERSION}\``,
    '',
    `## Verdict: **${r.verdict.outcome.toUpperCase()}**${r.verdict.refitRequired ? ' — constellation-specific re-fit required before the season opens' : ''}`,
    '',
    ...(r.verdict.reasons.length === 0 ? ['No findings.'] : r.verdict.reasons.map((x) => `- ${x}`)),
    '',
    '## Constellation',
    '',
    `\`${input.constellation.version}\` \`${input.constellation.digest}\` · season ${String(c.season)}`,
    '',
    `- live: ${r.constellation.live.join(', ')}`,
    `- attach-only (unchanged): ${r.constellation.attachOnly.join(', ')}`,
    ...r.constellation.dropped.map((id) => `- dropped \`${id}\`: ${c.droppedBecause[id] ?? ''}`),
    '',
    '## Inputs',
    '',
    ...(['DS-1', 'DS-3', 'DS-4'] as const).map((id) => {
      const m = input.inputs[id];
      return `- ${id}: ${String(m.files)} files, digest ${m.digest ?? '—'}`;
    }),
    '',
    `Restriction: DS-1 ${String(r.restriction.keptDetectionRows)}/${String(r.restriction.detectionRows)} rows kept, DS-4 ${String(r.restriction.keptGeoRows)}/${String(r.restriction.geoRows)} · dropped ${
      Object.entries(r.restriction.droppedRows)
        .map(([id, n]) => `${id} ${String(n)}`)
        .join(', ') || 'none'
    }`,
    '',
    '## Configs',
    '',
    `- incumbent \`${input.incumbent.version}\` \`${input.incumbent.digest}\``,
    `- fit rules \`${input.params.version}\` \`${input.params.digest}\``,
    `- grid \`${input.grid.version}\` \`${input.grid.digest}\``,
    '',
    '## Source coverage (acceptance seasons)',
    '',
    ...coverageTable(r.coverage.fit, r.coverage.calibrate, input),
    '',
    `Missing live sources: ${r.coverage.missing.length === 0 ? 'none' : r.coverage.missing.join(', ')}`,
    '',
    '## Acceptance of the incumbent on the restricted stream',
    '',
  ];
  for (const [name, split] of [
    ['Fit seasons', r.acceptance.fit],
    ['Calibrate season', r.acceptance.calibrate],
  ] as const) {
    if ('skipped' in split) lines.push(`### ${name}`, '', `Skipped: ${split.skipped}.`, '');
    else lines.push(...splitSection(name, split));
  }
  const refit = r.refit;
  lines.push(
    '## Constellation-specific re-fit',
    '',
    `Full report in \`${input.refitDir}/\`. ${
      refit.selected === null
        ? 'No acceptable configuration on the restricted stream.'
        : `Selected \`${refit.selected.cell.id}\` (digest \`${refit.selected.configDigest}\`), fit ${refit.selected.fit.verdict.pass ? 'PASS' : 'FAIL'}, calibrate ${'verdict' in refit.calibrate ? (refit.calibrate.verdict.pass ? 'PASS' : 'FAIL') : 'skipped'}, F1 spread ${refit.seasonSpread?.f1Spread?.toFixed(3) ?? '—'}.`
    }`,
    '',
    '## Decisions L-14 left open',
    '',
    ...CONSTELLATION_DECISIONS.map((d) => `- ${d}`),
    '',
  );
  return lines.join('\n');
}
