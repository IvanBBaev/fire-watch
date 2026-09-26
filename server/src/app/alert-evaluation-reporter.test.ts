import { describe, expect, it } from 'vitest';

import type { AlertEvaluationCycleReport } from '../core/alerts/evaluation-cycle.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import {
  reportAlertEvaluationCycle,
  reportAlertEvaluationDisabled,
} from './alert-evaluation-reporter.js';

const T0 = 1_765_620_900_000;
const T1 = T0 + 250;

const report = (behind: boolean): AlertEvaluationCycleReport => ({
  atIso: '2025-12-13T10:15:00.000Z',
  cursorFrom: '40',
  cursorTo: '42',
  batches: 1,
  behind,
  eventsRead: 2,
  skipped: { merged: 0, superseded: 0, noMembers: 0 },
  cipherFailures: 0,
  accountsWithoutSettings: 0,
  pairsDecided: 1,
  outcomes: { send: 1, seed: 0, defer: 0, suppress: 0 },
  reasons: { first_alert: 1 },
  undeliverable: 0,
  statesWritten: 1,
  outboxInserted: 1,
  outboxAlreadyDecided: 0,
  deferred: { over_budget_b: 0, manual_approval: 0 },
  decisionsLogged: 1,
});

function lines(run: JobRun<AlertEvaluationCycleReport>): string[] {
  const out: string[] = [];
  reportAlertEvaluationCycle(run, { writeLine: (line) => out.push(line) });
  return out;
}

describe('reportAlertEvaluationCycle', () => {
  it('writes one canonical line with the report, behind and the duration', () => {
    const [line, ...rest] = lines({
      startedAt: T0,
      finishedAt: T1,
      value: report(true),
      error: null,
    });
    expect(rest).toEqual([]);
    const parsed = JSON.parse(line ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['alert_evaluation_cycle', 'behind', 'duration_ms']);
    expect(parsed['behind']).toBe(true);
    expect(parsed['duration_ms']).toBe(250);
    expect(parsed['alert_evaluation_cycle']).toEqual(report(true));
  });

  it('is byte-identical for the same run', () => {
    const run = { startedAt: T0, finishedAt: T1, value: report(false), error: null };
    expect(lines(run)).toEqual(lines(run));
  });

  it('writes the failure with its message and instant', () => {
    const [line] = lines({
      startedAt: T0,
      finishedAt: T1,
      value: undefined,
      error: new Error('connection terminated'),
    });
    expect(JSON.parse(line ?? '')).toEqual({
      alert_evaluation_cycle_failed: { at: T1, error: 'connection terminated' },
    });
  });
});

describe('reportAlertEvaluationDisabled', () => {
  it('names the blockers and the gaps', () => {
    const out: string[] = [];
    reportAlertEvaluationDisabled(
      { blockers: ['zone_keyring_unset'], gaps: ['digest_pass_unwired'] },
      { writeLine: (line) => out.push(line) },
    );
    expect(out).toEqual([
      '{"alert_evaluation_disabled":{"blockers":["zone_keyring_unset"],"gaps":["digest_pass_unwired"]}}',
    ]);
  });
});
