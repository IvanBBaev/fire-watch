/**
 * The report format: one JSON document per run (or per shard), plus a Markdown rendering
 * for the gate record. The JSON carries the scenario, the raw metrics and the evaluation,
 * so it is self-contained evidence — `merge` folds shard reports into one and re-evaluates.
 */

import { evaluate, type Evaluation } from './evaluate.js';
import { mergeMetrics, type MetricsData } from './metrics.js';
import { buildScenario, type Scenario } from './scenario.js';

export const REPORT_SCHEMA = 'fire-watch.loadtest.report/v1';

export interface RunInfo {
  /** ISO instants, taken by the CLI adapter. */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: { readonly baseUrl: string; readonly t2Url: string | null };
  readonly seed: number;
  readonly generator: string;
}

export interface Report {
  readonly schema: typeof REPORT_SCHEMA;
  readonly run: RunInfo;
  /** One entry per shard folded into this report. */
  readonly shards: readonly { readonly index: number; readonly count: number }[];
  readonly scenario: Scenario;
  readonly metrics: MetricsData;
  readonly evaluation: Evaluation;
}

export class ReportError extends Error {
  override readonly name = 'ReportError';
}

export function buildReport(scenario: Scenario, metrics: MetricsData, run: RunInfo): Report {
  return {
    schema: REPORT_SCHEMA,
    run,
    shards: [scenario.shard],
    scenario,
    metrics,
    evaluation: evaluate(scenario, metrics),
  };
}

/**
 * Folds shard reports of one run into the whole-run report. The shards must describe the
 * same test (baseline, multiplier, scale, cap, phases) and together cover every shard
 * exactly once; the merged scenario is the unsharded one, so its targets are the totals.
 */
export function mergeReports(reports: readonly Report[]): Report {
  const first = reports[0];
  if (first === undefined) throw new ReportError('nothing to merge');
  for (const report of reports) {
    if (report.schema !== REPORT_SCHEMA)
      throw new ReportError(`unknown report schema: ${String(report.schema)}`);
  }
  const fingerprint = (s: Scenario): string =>
    JSON.stringify([s.baseline, s.assumptions, s.multiplier, s.scale, s.sseCap, s.phases]);
  const expected = fingerprint(first.scenario);
  for (const report of reports) {
    if (fingerprint(report.scenario) !== expected) {
      throw new ReportError('shard reports describe different scenarios');
    }
  }
  const shards = reports.flatMap((r) => r.shards);
  const count = first.scenario.shard.count;
  const indices = shards.map((s) => s.index).sort((a, b) => a - b);
  const complete =
    shards.every((s) => s.count === count) &&
    indices.length === count &&
    indices.every((index, i) => index === i + 1);
  if (!complete) {
    throw new ReportError(
      `shard reports must cover shards 1..${count} exactly once; got ${indices.join(',')}`,
    );
  }

  const phases = first.scenario.phases;
  const scenario = buildScenario({
    baseline: first.scenario.baseline,
    assumptions: first.scenario.assumptions,
    multiplier: first.scenario.multiplier,
    scale: first.scenario.scale,
    sseCap: first.scenario.sseCap,
    durationsMs: {
      ramp: phases.find((p) => p.name === 'ramp')?.durationMs ?? 0,
      steady: phases.find((p) => p.name === 'steady')?.durationMs ?? 0,
      originKill: phases.find((p) => p.name === 'origin-kill')?.durationMs ?? 0,
    },
  });
  const metrics = mergeMetrics(reports.map((r) => r.metrics));
  const startedAt = reports.map((r) => r.run.startedAt).sort()[0] ?? first.run.startedAt;
  const finishedAt =
    reports
      .map((r) => r.run.finishedAt)
      .sort()
      .at(-1) ?? first.run.finishedAt;
  return {
    schema: REPORT_SCHEMA,
    run: { ...first.run, startedAt, finishedAt, generator: `${reports.length} shards` },
    shards,
    scenario,
    metrics,
    evaluation: evaluate(scenario, metrics),
  };
}

const OP_TEXT = { gte: '≥', lte: '≤', eq: '=' } as const;

export function renderMarkdown(report: Report): string {
  const { scenario, evaluation, run } = report;
  const lines: string[] = [];
  lines.push(
    `# Load test — GATES L-3 — ${evaluation.overall.toUpperCase()}${evaluation.rehearsal ? ' (rehearsal)' : ''}`,
  );
  lines.push('');
  lines.push(
    `- Target: ${run.target.baseUrl}${run.target.t2Url === null ? '' : ` · T2 ${run.target.t2Url}`}`,
  );
  lines.push(
    `- Window: ${run.startedAt} → ${run.finishedAt} · seed ${run.seed} · ${run.generator}`,
  );
  lines.push(
    `- Baseline (${scenario.baseline.source}): ${scenario.baseline.sessions} sessions / ` +
      `${scenario.baseline.snapshotRequestsPerMinute} req/min / ${scenario.baseline.sseConnections} SSE — ` +
      `${scenario.baseline.label}`,
  );
  lines.push(
    `- Scale: ${scenario.multiplier}× × ${scenario.scale} → ${round(scenario.totals.sessions)} sessions, ` +
      `${round(scenario.totals.snapshotRequestsPerMinute)} snapshot req/min, ` +
      `${scenario.totals.sseConnections} SSE attempts against a cap of ${scenario.sseCap}`,
  );
  lines.push(
    `- Phases: ${scenario.phases.map((p) => `${p.name} ${p.durationMs / 1000}s`).join(', ')}`,
  );
  lines.push('');
  lines.push('| Criterion | Observed | Bound | Verdict | Source |');
  lines.push('|---|---|---|---|---|');
  for (const v of evaluation.verdicts) {
    const observed = v.observed === null ? '—' : `${round(v.observed)} ${v.unit}`;
    lines.push(
      `| ${v.id}${v.kind === 'validity' ? ' (validity)' : ''} | ${observed} | ${OP_TEXT[v.op]} ${round(v.bound)} ${v.unit} | ${v.state} | ${v.source} |`,
    );
  }
  if (evaluation.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of evaluation.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}

function round(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 10 ? 3 : 1);
}
