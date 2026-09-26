import { describe, expect, it } from 'vitest';

import { isoWeekWindow } from '../core/qa/iso-week.js';
import { buildWeeklyReport } from '../core/qa/weekly-report.js';
import type { WeeklyQaReportOutcome } from '../core/qa/weekly-report-job.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { loadConfig, type Environment } from './config.js';
import { QA_REPORT_INTERVAL_MS, reportQaWeekly, wireQaReport } from './qa-report-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
  FIRE_WATCH_POLL_INTERVAL_MS: '300000',
};

const run = (
  value: WeeklyQaReportOutcome | undefined,
  error: unknown = null,
): JobRun<WeeklyQaReportOutcome> => ({ startedAt: 0, finishedAt: 1_000, value, error });

describe('wireQaReport', () => {
  it('wires one store as both reader and writer, graded at the worker poll interval', async () => {
    const wiring = wireQaReport(loadConfig(ENV, 'fire-watch-test'));
    expect(wiring.deps.reader).toBe(wiring.deps.store);
    expect(wiring.deps.pollIntervalMs).toBe(300_000);
    expect(typeof wiring.deps.clock.now).toBe('function');
    await wiring.close();
  });

  it('runs hourly, so a closed week lands within an hour of Monday 00:00 UTC', () => {
    expect(QA_REPORT_INTERVAL_MS).toBe(3_600_000);
  });
});

describe('reportQaWeekly', () => {
  it('prints a skip as one canonical line', () => {
    const lines: string[] = [];
    reportQaWeekly(run({ outcome: 'skipped', isoWeek: '2026-W38', reason: 'already_stored' }), {
      writeLine: (line) => lines.push(line),
    });
    expect(lines).toEqual([
      '{"qa_weekly_report":{"isoWeek":"2026-W38","outcome":"skipped","reason":"already_stored"}}',
    ]);
  });

  it('prints the summary of a built report, never its body', () => {
    const window = isoWeekWindow('2026-W38');
    const report = buildWeeklyReport({
      window,
      generatedAtMs: window.toMs,
      pollIntervalMs: 600_000,
      plbTraces: [],
      darAlerts: [],
      lifecycle: { logStartedAtMs: null, transitions: [], population: [] },
    });
    const lines: string[] = [];
    reportQaWeekly(
      run({
        outcome: 'built',
        isoWeek: '2026-W38',
        persisted: true,
        report,
        json: 'JSON-BODY',
        markdown: 'MARKDOWN-BODY',
      }),
      { writeLine: (line) => lines.push(line) },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('BODY');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      qa_weekly_report: { outcome: 'built', isoWeek: '2026-W38', persisted: true },
    });
  });

  it('prints the failure when the run threw', () => {
    const lines: string[] = [];
    reportQaWeekly(run(undefined, new Error('boom')), { writeLine: (line) => lines.push(line) });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      qa_weekly_report_failed: { error: 'boom', at: 1_000 },
    });
  });
});
