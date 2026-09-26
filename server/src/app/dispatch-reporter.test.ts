import { describe, expect, it } from 'vitest';

import { dispatchAllowance } from '../core/alerts/dispatch-breaker.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { reportDispatch } from './dispatch-reporter.js';
import type { DispatchJobReport } from './dispatch-wiring.js';

const T0 = 1_785_670_200_000;
const T1 = T0 + 1_200;

const report = (
  control: DispatchJobReport['control'],
  sendsInWindow: number | null,
): DispatchJobReport => ({
  expiredLeases: 0,
  releasedAbandoned: 0,
  control,
  sendsInWindow,
  sendRateError: sendsInWindow === null ? 'statement timeout' : null,
  allowance: dispatchAllowance({
    control,
    sendsInWindow,
    baselineSendsPerWindow: null,
    batchSize: 100,
  }),
  latchedBreaker: false,
  gateway: null,
  rowErrors: {},
  dropped: { expired_unapproved: 0, ttl_expired: 0 },
});

const OPEN = { killSwitch: false, breakerLatched: false };

const completedRun = (value: DispatchJobReport): JobRun<DispatchJobReport> => ({
  startedAt: T0,
  finishedAt: T1,
  value,
  error: null,
});

function capture(run: JobRun<DispatchJobReport>): Record<string, unknown>[] {
  const lines: string[] = [];
  reportDispatch(run, { writeLine: (line) => lines.push(line) });
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('reportDispatch', () => {
  it('writes one line per cycle, with the whole report and no page when dispatch is open', () => {
    const lines = capture(completedRun(report(OPEN, 3)));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['pages']).toBe(false);
    expect(lines[0]?.['alert_dispatch']).toMatchObject({
      sendsInWindow: 3,
      allowance: { state: 'open', claimLimit: 100 },
      gateway: null,
    });
  });

  it('pages on a halt nobody asked for', () => {
    expect(capture(completedRun(report(OPEN, null)))[0]?.['pages']).toBe(true);
    expect(capture(completedRun(report(OPEN, 2_000)))[0]?.['pages']).toBe(true);
  });

  it('does not page on the kill switch, the one halt a human chose', () => {
    const lines = capture(completedRun(report({ killSwitch: true, breakerLatched: false }, 0)));
    expect(lines[0]?.['pages']).toBe(false);
  });

  it('writes a failure line when the cycle itself threw', () => {
    const lines = capture({
      startedAt: T0,
      finishedAt: T1,
      value: undefined,
      error: new Error('EACCES: kill-switch'),
    });
    expect(lines).toEqual([{ alert_dispatch_failed: { error: 'EACCES: kill-switch', at: T1 } }]);
  });

  it('describes a non-Error throw rather than dropping it', () => {
    const lines = capture({ startedAt: T0, finishedAt: T1, value: undefined, error: 'boom' });
    expect(lines[0]).toEqual({ alert_dispatch_failed: { error: 'boom', at: T1 } });
  });
});
