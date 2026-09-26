import { describe, expect, it } from 'vitest';

import { PURGE_RETENTION, PURGE_ROW_LIMIT, type PurgeReport } from '../core/erasure/purge-plan.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { loadConfig, type Environment } from './config.js';
import {
  ERASURE_PURGE_INTERVAL_MS,
  reportErasurePurge,
  runErasurePurge,
  wireErasurePurge,
} from './erasure-purge-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

const REPORT: PurgeReport = {
  at: '2026-09-23T03:00:00Z',
  targets: {
    erasure_ledger: { armed: false },
    expired_link_requests: { armed: false },
    ended_sessions: { armed: true, cutoff: '2026-09-16T03:00:00Z', deleted: 4, more: false },
    account_tombstones: { armed: false },
    alert_decision_log: { armed: false },
    alert_digest_log: { armed: false },
  },
};

const run = (value: PurgeReport | undefined, error: unknown = null): JobRun<PurgeReport> => ({
  startedAt: 0,
  finishedAt: 1_000,
  value,
  error,
});

describe('wireErasurePurge', () => {
  it('wires the shipped, unarmed retention and the row cap', async () => {
    const wiring = wireErasurePurge(loadConfig(ENV, 'fire-watch-test'));
    expect(wiring.deps.retention).toBe(PURGE_RETENTION);
    expect(wiring.deps.limit).toBe(PURGE_ROW_LIMIT);
    await wiring.close();
  });

  it('runs daily', () => {
    expect(ERASURE_PURGE_INTERVAL_MS).toBe(86_400_000);
  });
});

describe('runErasurePurge', () => {
  it('with the shipped retention touches no table even though the pool is unreachable', async () => {
    const wiring = wireErasurePurge(loadConfig(ENV, 'fire-watch-test'));
    const report = await runErasurePurge({
      ...wiring.deps,
      clock: new VirtualClock('2026-09-23T03:00:00Z'),
    });
    expect(Object.values(report.targets).every((target) => !target.armed)).toBe(true);
    await wiring.close();
  });

  it('runs an armed target at the clock time', async () => {
    const calls: string[] = [];
    const report = await runErasurePurge({
      executor: {
        purge: (target, cutoff) => {
          calls.push(`${target}@${cutoff}`);
          return Promise.resolve(0);
        },
      },
      clock: new VirtualClock('2026-09-23T03:00:00Z'),
      retention: { ...PURGE_RETENTION, ended_sessions: 7 },
      limit: 10,
    });
    expect(calls).toEqual(['ended_sessions@2026-09-16T03:00:00Z']);
    expect(report.targets.ended_sessions).toEqual({
      armed: true,
      cutoff: '2026-09-16T03:00:00Z',
      deleted: 0,
      more: false,
    });
  });
});

describe('reportErasurePurge', () => {
  it('prints the report as one canonical line', () => {
    const lines: string[] = [];
    reportErasurePurge(run(REPORT), { writeLine: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ erasure_purge: REPORT });
    expect(lines[0]).not.toContain('\n');
  });

  it('prints the failure when the run threw', () => {
    const lines: string[] = [];
    reportErasurePurge(run(undefined, new Error('refused')), {
      writeLine: (line) => lines.push(line),
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      erasure_purge_failed: { error: 'refused', at: 1_000 },
    });
  });
});
