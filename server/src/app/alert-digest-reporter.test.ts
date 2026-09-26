import { describe, expect, it } from 'vitest';

import type { AlertDigestCycleReport } from '../core/alerts/digest-pass.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { reportAlertDigestCycle, reportAlertDigestDisabled } from './alert-digest-reporter.js';

const T0 = 1_765_620_900_000;
const T1 = T0 + 250;

const report: AlertDigestCycleReport = {
  atIso: '2025-12-13T10:15:00Z',
  pages: 1,
  accountsRead: 2,
  accountsFailed: 0,
  accountsGone: 0,
  outcomes: { none: 0, hold: 0, suppress: 1, send: 1 },
  undeliverable: 0,
  groupsWithoutCopy: 0,
  alreadyDecided: 0,
  cipherFailures: 0,
  pairsRead: 3,
  pairsOutsideZone: 0,
  candidates: { deferred: 1, seeded: 0, active: 2 },
  linesSent: 2,
  digestsLogged: 2,
  outboxInserted: 1,
  outboxAlreadyDecided: 0,
  deferred: { over_budget_b: 0, manual_approval: 0 },
};

function lines(run: JobRun<AlertDigestCycleReport>): string[] {
  const out: string[] = [];
  reportAlertDigestCycle(run, { writeLine: (line) => out.push(line) });
  return out;
}

describe('reportAlertDigestCycle', () => {
  it('writes the whole report and the duration on one line', () => {
    const [line, extra] = lines({ startedAt: T0, finishedAt: T1, value: report, error: null });
    expect(extra).toBeUndefined();
    expect(JSON.parse(line ?? '')).toEqual({ alert_digest_cycle: report, duration_ms: 250 });
  });

  it('writes the failure with its message and when it happened', () => {
    const [line] = lines({
      startedAt: T0,
      finishedAt: T1,
      value: undefined,
      error: new Error('every one of 2 digest accounts failed'),
    });
    expect(JSON.parse(line ?? '')).toEqual({
      alert_digest_cycle_failed: { error: 'every one of 2 digest accounts failed', at: T1 },
    });
  });
});

describe('reportAlertDigestDisabled', () => {
  it('names every blocker, in order', () => {
    const out: string[] = [];
    reportAlertDigestDisabled(
      { blockers: ['zone_keyring_unset', 'digest_routing_unarmed', 'cadence_unratified'] },
      { writeLine: (line) => out.push(line) },
    );
    expect(out).toEqual([
      '{"alert_digest_disabled":{"blockers":["zone_keyring_unset","digest_routing_unarmed","cadence_unratified"]}}',
    ]);
  });
});
