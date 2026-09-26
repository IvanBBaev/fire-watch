import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  planPurge,
  PURGE_RETENTION,
  PURGE_ROW_LIMIT,
  PURGE_TARGETS,
  PurgeRetentionError,
  runPurge,
  type PurgeExecutor,
  type PurgeRetention,
  type PurgeTarget,
} from './purge-plan.js';

const AT = epochMsFromIso('2026-09-23T03:00:00Z');
const UNARMED: PurgeRetention = {
  erasure_ledger: null,
  expired_link_requests: null,
  ended_sessions: null,
  account_tombstones: null,
  alert_decision_log: null,
  alert_digest_log: null,
};

function recordingExecutor(answer: (target: PurgeTarget) => number = () => 0) {
  const calls: [PurgeTarget, string, number][] = [];
  const executor: PurgeExecutor = {
    purge(target, cutoffIso, limit) {
      calls.push([target, cutoffIso, limit]);
      return Promise.resolve(answer(target));
    },
  };
  return { executor, calls };
}

describe('the shipped retention', () => {
  it('arms nothing: no retention is ratified', () => {
    expect(PURGE_RETENTION).toEqual(UNARMED);
    expect(planPurge(AT).every((step) => !step.armed)).toBe(true);
  });

  it('runs without touching the executor and says so for every target', async () => {
    const { executor, calls } = recordingExecutor();
    const report = await runPurge(AT, executor);
    expect(calls).toEqual([]);
    expect(report).toEqual({
      at: '2026-09-23T03:00:00Z',
      targets: Object.fromEntries(PURGE_TARGETS.map((target) => [target, { armed: false }])),
    });
  });
});

describe('planPurge', () => {
  it('computes the cutoff as now minus the retention', () => {
    const steps = planPurge(AT, { ...UNARMED, ended_sessions: 7, erasure_ledger: 30 });
    expect(steps).toEqual([
      {
        target: 'erasure_ledger',
        armed: true,
        retentionDays: 30,
        cutoffIso: '2026-08-24T03:00:00Z',
      },
      { target: 'expired_link_requests', armed: false },
      {
        target: 'ended_sessions',
        armed: true,
        retentionDays: 7,
        cutoffIso: '2026-09-16T03:00:00Z',
      },
      { target: 'account_tombstones', armed: false },
      { target: 'alert_decision_log', armed: false },
      { target: 'alert_digest_log', armed: false },
    ]);
  });

  it('refuses a ledger retention inside the erasure horizon', () => {
    expect(() => planPurge(AT, { ...UNARMED, erasure_ledger: 29 })).toThrow(PurgeRetentionError);
  });

  it('refuses a link-request retention of zero: the issue window still counts them', () => {
    expect(() => planPurge(AT, { ...UNARMED, expired_link_requests: 0 })).toThrow(/floor/);
    expect(planPurge(AT, { ...UNARMED, expired_link_requests: 1 })[1]).toMatchObject({
      armed: true,
    });
  });

  it('refuses a fractional or negative retention', () => {
    expect(() => planPurge(AT, { ...UNARMED, ended_sessions: 1.5 })).toThrow(/whole/);
    expect(() => planPurge(AT, { ...UNARMED, account_tombstones: -1 })).toThrow(/whole/);
  });
});

describe('runPurge', () => {
  it('passes the cutoff and the limit, and flags a full batch as more', async () => {
    const { executor, calls } = recordingExecutor((target) =>
      target === 'ended_sessions' ? 5 : 2,
    );
    const report = await runPurge(
      AT,
      executor,
      { ...UNARMED, ended_sessions: 0, account_tombstones: 0 },
      5,
    );
    expect(calls).toEqual([
      ['ended_sessions', '2026-09-23T03:00:00Z', 5],
      ['account_tombstones', '2026-09-23T03:00:00Z', 5],
    ]);
    expect(report.targets.ended_sessions).toEqual({
      armed: true,
      cutoff: '2026-09-23T03:00:00Z',
      deleted: 5,
      more: true,
    });
    expect(report.targets.account_tombstones).toMatchObject({ deleted: 2, more: false });
  });

  it('defaults to the shipped row limit', async () => {
    const { executor, calls } = recordingExecutor();
    await runPurge(AT, executor, { ...UNARMED, ended_sessions: 1 });
    expect(calls[0]?.[2]).toBe(PURGE_ROW_LIMIT);
  });

  it('refuses before deleting anything when one retention is invalid', async () => {
    const { executor, calls } = recordingExecutor();
    await expect(
      runPurge(AT, executor, { ...UNARMED, ended_sessions: 1, erasure_ledger: 1 }),
    ).rejects.toThrow(PurgeRetentionError);
    expect(calls).toEqual([]);
  });
});
