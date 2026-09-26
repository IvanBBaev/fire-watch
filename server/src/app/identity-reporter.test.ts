import { describe, expect, it } from 'vitest';

import type { IdentityCycleReport } from '../core/identity/identity-cycle.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { reportIdentityCycle } from './identity-reporter.js';

const T0 = 1_765_620_900_000;
const T1 = T0 + 1_500;

const report = (limitReached: boolean): IdentityCycleReport => ({
  runId: 1,
  batches: { pending: 24, applied: 23, skipped: 1, limitReached },
  stats: {
    detections: 5,
    seeded: 1,
    attached: 3,
    merged: 1,
    unattached: 0,
    alreadyAssigned: 0,
    footprintDefaulted: 2,
    evicted: 0,
  },
  reignitionLinks: 0,
  tick: {
    atIso: '2025-12-13T10:15:00Z',
    sinceIso: '2025-12-13T10:14:00Z',
    events: 4,
    curatedSkipped: 0,
    transitions: 1,
    missing: 0,
  },
});

function lines(run: JobRun<IdentityCycleReport>): string[] {
  const out: string[] = [];
  reportIdentityCycle(run, { writeLine: (line) => out.push(line) });
  return out;
}

describe('reportIdentityCycle', () => {
  it('writes one canonical line carrying the whole report, the lag flag and the duration', () => {
    const out = lines({ startedAt: T0, finishedAt: T1, value: report(true), error: null });
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] ?? '') as Record<string, unknown>;
    expect(parsed).toEqual({ identity_cycle: report(true), behind: true, duration_ms: 1_500 });
    // Canonical: keys sorted, so two cycles diff line by line.
    expect(out[0]?.indexOf('"behind"')).toBeLessThan(out[0]?.indexOf('"identity_cycle"') ?? 0);
  });

  it('is not behind when the cycle drained what was pending', () => {
    const out = lines({ startedAt: T0, finishedAt: T1, value: report(false), error: null });
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ behind: false });
  });

  it('writes a failure line with the error message when the cycle threw', () => {
    const out = lines({
      startedAt: T0,
      finishedAt: T1,
      value: undefined,
      error: new Error('tombstone write touched 0 rows, expected 1'),
    });
    expect(JSON.parse(out[0] ?? '')).toEqual({
      identity_cycle_failed: { error: 'tombstone write touched 0 rows, expected 1', at: T1 },
    });
  });

  it('describes a non-Error rejection too', () => {
    const out = lines({ startedAt: T0, finishedAt: T1, value: undefined, error: 'boom' });
    expect(JSON.parse(out[0] ?? '')).toEqual({ identity_cycle_failed: { error: 'boom', at: T1 } });
  });
});
