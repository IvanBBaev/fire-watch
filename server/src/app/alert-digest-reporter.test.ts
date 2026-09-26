import { describe, expect, it } from 'vitest';

import type { AlertDigestCycleReport } from '../core/alerts/digest-pass.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { reportAlertDigestCycle, reportAlertDigestDisabled } from './alert-digest-reporter.js';

const T0 = 1_765_620_900_000;
const T1 = T0 + 250;

const report = (undeliverable: number): AlertDigestCycleReport => ({
  atIso: '2025-12-13T07:05:00Z',
  pages: 1,
  accountsRead: 2,
  accountsFailed: 0,
  accountsGone: 0,
  outcomes: { send: 1, hold: 0, suppress: 1, none: 0 },
  undeliverable,
  groupsWithoutCopy: 0,
  alreadyDecided: 0,
  cipherFailures: 0,
  pairsRead: 3,
  pairsOutsideZone: 0,
  candidates: { deferred: 1, seeded: 0, active: 2 },
  linesSent: 3,
  digestsLogged: 3,
  outboxInserted: 1,
  outboxAlreadyDecided: 0,
  deferred: { over_budget_b: 0, manual_approval: 0 },
});

function lines(run: JobRun<AlertDigestCycleReport>): string[] {
  const out: string[] = [];
  reportAlertDigestCycle(run, { writeLine: (line) => out.push(line) });
  return out;
}

describe('reportAlertDigestCycle', () => {
  it('writes one canonical line with the report, undeliverable and the duration', () => {
    const [line, ...rest] = lines({ startedAt: T0, finishedAt: T1, value: report(2), error: null });
    expect(rest).toEqual([]);
    const parsed = JSON.parse(line ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['alert_digest_cycle', 'duration_ms', 'undeliverable']);
    expect(parsed['undeliverable']).toBe(2);
    expect(parsed['duration_ms']).toBe(250);
    expect(parsed['alert_digest_cycle']).toEqual(report(2));
  });

  it('is byte-identical for the same run', () => {
    const run = { startedAt: T0, finishedAt: T1, value: report(0), error: null };
    expect(lines(run)).toEqual(lines(run));
  });

  it('writes the failure with its message and instant', () => {
    const [line] = lines({
      startedAt: T0,
      finishedAt: T1,
      value: undefined,
      error: new Error('every one of 2 digest accounts failed'),
    });
    expect(JSON.parse(line ?? '')).toEqual({
      alert_digest_cycle_failed: { at: T1, error: 'every one of 2 digest accounts failed' },
    });
  });
});

describe('reportAlertDigestDisabled', () => {
  it('names the blockers', () => {
    const out: string[] = [];
    reportAlertDigestDisabled(
      { blockers: ['digest_routing_unarmed', 'cadence_unratified'] },
      { writeLine: (line) => out.push(line) },
    );
    expect(out).toEqual([
      '{"alert_digest_disabled":{"blockers":["digest_routing_unarmed","cadence_unratified"]}}',
    ]);
  });
});
