import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import type { SanityCheck, SanityReport, SwapObservations } from './sanity-checks.js';
import { SP_SWAP_SANITY, decideSwap, evaluateSanityChecks } from './sanity-checks.js';

function observations(overrides: Partial<SwapObservations> = {}): SwapObservations {
  return {
    liveRows: 90,
    liveNonNrtRows: 0,
    liveSourceDays: [{ source: 'firms:viirs:snpp', day: '2020-07-01' }],
    stagedRows: 100,
    stagedSourceDays: [{ source: 'firms:viirs:snpp', day: '2020-07-01' }],
    stagedOutsideMonth: 0,
    stagedOutsideBbox: 0,
    stagedDuplicateUids: 0,
    ...overrides,
  };
}

function check(report: SanityReport, name: string): SanityCheck {
  const found = report.checks.find((entry) => entry.check === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

const FITTED = defineConfig('sp_swap_sanity', 'sp_swap_sanity_v999', {
  countRatioBand: { min: 0.9, max: 1.5 },
});

describe('evaluateSanityChecks', () => {
  it('runs the five A1.4 checks plus the documented NRT-only interlock', () => {
    const report = evaluateSanityChecks(observations());
    expect(report.checks.map((entry) => entry.check)).toEqual([
      'count_ratio',
      'source_day_coverage',
      'acq_ts_in_month',
      'geometry_in_bbox',
      'uid_uniqueness',
      'live_partition_nrt_only',
    ]);
    expect(report.configVersion).toBe(SP_SWAP_SANITY.version);
    expect(report.configDigest).toBe(SP_SWAP_SANITY.digest);
  });

  it('asks for the operator while the count band is unfitted — never passes the count', () => {
    const report = evaluateSanityChecks(observations());
    expect(check(report, 'count_ratio').status).toBe('needs_operator');
    expect(report.verdict).toBe('needs_operator');
    // Everything else on clean observations is green.
    for (const entry of report.checks) {
      if (entry.check !== 'count_ratio') expect(entry.status).toBe('pass');
    }
  });

  it('passes the count check when a fitted band contains the ratio', () => {
    const report = evaluateSanityChecks(observations(), FITTED);
    expect(check(report, 'count_ratio').status).toBe('pass');
    expect(report.verdict).toBe('pass');
  });

  it('fails the count check when the ratio leaves a fitted band', () => {
    const report = evaluateSanityChecks(observations({ stagedRows: 500 }), FITTED);
    expect(check(report, 'count_ratio').status).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('asks for the operator when the live partition is empty — the ratio is undefined', () => {
    const report = evaluateSanityChecks(observations({ liveRows: 0, liveSourceDays: [] }), FITTED);
    expect(check(report, 'count_ratio').status).toBe('needs_operator');
  });

  it('fails coverage when an NRT (source, day) has no SP rows', () => {
    const report = evaluateSanityChecks(
      observations({
        liveSourceDays: [
          { source: 'firms:viirs:snpp', day: '2020-07-01' },
          { source: 'firms:viirs:snpp', day: '2020-07-02' },
        ],
      }),
    );
    const coverage = check(report, 'source_day_coverage');
    expect(coverage.status).toBe('fail');
    expect(coverage.detail).toContain('firms:viirs:snpp@2020-07-02');
    expect(report.verdict).toBe('fail');
  });

  it('accepts SP days NRT never saw — coverage is one-directional', () => {
    const report = evaluateSanityChecks(
      observations({
        stagedSourceDays: [
          { source: 'firms:viirs:snpp', day: '2020-07-01' },
          { source: 'firms:viirs:snpp', day: '2020-07-15' },
        ],
      }),
    );
    expect(check(report, 'source_day_coverage').status).toBe('pass');
  });

  it('fails when staged rows fall outside the month window', () => {
    const report = evaluateSanityChecks(observations({ stagedOutsideMonth: 3 }));
    expect(check(report, 'acq_ts_in_month').status).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('fails when staged geometry leaves the polling bbox', () => {
    const report = evaluateSanityChecks(observations({ stagedOutsideBbox: 1 }));
    expect(check(report, 'geometry_in_bbox').status).toBe('fail');
  });

  it('fails when a staged detection_uid is duplicated', () => {
    const report = evaluateSanityChecks(observations({ stagedDuplicateUids: 2 }));
    expect(check(report, 'uid_uniqueness').status).toBe('fail');
  });

  it('refuses to detach a partition holding non-NRT rows', () => {
    const report = evaluateSanityChecks(observations({ liveNonNrtRows: 7 }));
    expect(check(report, 'live_partition_nrt_only').status).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('lets fail outrank needs_operator in the verdict', () => {
    const report = evaluateSanityChecks(observations({ stagedDuplicateUids: 1 }));
    expect(check(report, 'count_ratio').status).toBe('needs_operator');
    expect(report.verdict).toBe('fail');
  });
});

describe('decideSwap', () => {
  it('blocks a failed report regardless of confirmation', () => {
    const report = evaluateSanityChecks(observations({ stagedOutsideBbox: 5 }));
    expect(decideSwap(report, true)).toBe('blocked_failed');
    expect(decideSwap(report, false)).toBe('blocked_failed');
  });

  it('waits for the operator while the band is unfitted', () => {
    const report = evaluateSanityChecks(observations());
    expect(decideSwap(report, false)).toBe('blocked_needs_operator');
    expect(decideSwap(report, true)).toBe('proceed');
  });

  it('proceeds without confirmation once every check passes', () => {
    const report = evaluateSanityChecks(observations(), FITTED);
    expect(decideSwap(report, false)).toBe('proceed');
  });
});
