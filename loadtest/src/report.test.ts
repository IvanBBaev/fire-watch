import { describe, expect, it } from 'vitest';

import { MetricsRecorder } from './metrics.js';
import {
  REPORT_SCHEMA,
  ReportError,
  buildReport,
  mergeReports,
  renderMarkdown,
  type RunInfo,
} from './report.js';
import { buildScenario } from './scenario.js';

const durationsMs = { ramp: 1_000, steady: 2_000, originKill: 0 };
const run = (i: number): RunInfo => ({
  startedAt: `2026-09-24T10:0${i}:00.000Z`,
  finishedAt: `2026-09-24T10:1${i}:00.000Z`,
  target: { baseUrl: 'https://edge.example', t2Url: null },
  seed: 1,
  generator: `gen-${i}`,
});

function shardReport(index: number, count: number, opened: number) {
  const scenario = buildScenario({ scale: 0.01, shard: { index, count }, durationsMs });
  const r = new MetricsRecorder();
  r.setPhaseDuration('steady', 2_000);
  for (let i = 0; i < opened; i += 1) {
    r.sseAttempt('steady');
    r.sseOpened('steady');
  }
  r.response('steady', 'snapshot', { status: 200, latencyMs: 20, cacheStatus: 'HIT' });
  return buildReport(scenario, r.toJSON(), run(index));
}

describe('reports', () => {
  it('carries scenario, metrics and evaluation in one self-contained document', () => {
    const report = shardReport(1, 1, 3);
    expect(report.schema).toBe(REPORT_SCHEMA);
    expect(report.shards).toEqual([{ index: 1, count: 1 }]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('merges shards into the unsharded scenario and re-evaluates', () => {
    const merged = mergeReports([shardReport(2, 2, 4), shardReport(1, 2, 3)]);
    expect(merged.scenario.shard).toEqual({ index: 1, count: 1 });
    expect(merged.scenario.targets.sseConnections).toBe(merged.scenario.totals.sseConnections);
    expect(merged.metrics.phases.steady.sse.peakOpen).toBe(7);
    expect(merged.evaluation.metrics.ssePeakOpen).toBe(7);
    expect(merged.run.startedAt).toBe('2026-09-24T10:01:00.000Z');
    expect(merged.run.finishedAt).toBe('2026-09-24T10:12:00.000Z');
  });

  it('refuses a missing, duplicated or foreign shard', () => {
    expect(() => mergeReports([])).toThrow(ReportError);
    expect(() => mergeReports([shardReport(1, 2, 0)])).toThrow(/exactly once/);
    expect(() => mergeReports([shardReport(1, 2, 0), shardReport(1, 2, 0)])).toThrow(
      /exactly once/,
    );
    const other = {
      ...shardReport(2, 2, 0),
      scenario: buildScenario({ scale: 0.02, shard: { index: 2, count: 2 }, durationsMs }),
    };
    expect(() => mergeReports([shardReport(1, 2, 0), other])).toThrow(/different scenarios/);
  });

  it('renders a gate record with one row per criterion', () => {
    const report = shardReport(1, 1, 3);
    const markdown = renderMarkdown(report);
    expect(markdown).toMatch(/^# Load test — GATES L-3 — INCOMPLETE \(rehearsal\)/);
    expect(markdown).toContain('| edge-hit-ratio | 1 ratio | ≥ 0.950 ratio | pass |');
    expect(markdown).toContain('| generator-achieved-rate (validity) |');
    const rows = markdown
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Criterion'));
    expect(rows).toHaveLength(report.evaluation.verdicts.length);
    expect(markdown).toContain('Notes:');
  });
});
