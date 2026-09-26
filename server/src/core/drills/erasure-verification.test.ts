import { describe, expect, it } from 'vitest';

import { backupObjectKey } from '../backup/backup-keys.js';
import type { ErasureOutcome } from '../erasure/erase-account.js';
import { ERASURE_PLAN, ERASURE_PLAN_VERSION } from '../erasure/erasure-plan.js';
import { epochMsFromIso } from '../ports/clock.js';
import {
  expectedErasureCounts,
  verifyBackupErasure,
  verifyErasure,
  type DeletedTable,
  type ErasureDrillObservation,
  type ErasureDrillSeed,
} from './erasure-verification.js';

const DAY = 86_400_000;
const ERASED_MS = epochMsFromIso('2026-09-25T10:00:00Z');
const DEADLINE_MS = ERASED_MS + 30 * DAY;

const ROWS: Record<DeletedTable, number> = {
  alert_states: 1,
  alerts_shadow: 1,
  alert_decision_log: 2,
  alert_digest_log: 3,
  watch_zones: 4,
  channel_confirmations: 2,
  channel_subscriptions: 1,
  account_sessions: 1,
  auth_link_requests: 1,
};
const ZERO: Record<DeletedTable, number> = Object.fromEntries(
  Object.keys(ROWS).map((table) => [table, 0]),
) as Record<DeletedTable, number>;

const SEED: ErasureDrillSeed = {
  accountId: 'a0000000-0000-4000-8000-000000000001',
  email: 'drill-x@example.invalid',
  zoneIds: ['z1', 'z2', 'z3', 'z4'],
  rows: ROWS,
  outbox: [
    { id: 'o1000000', seededStatus: 'pending' },
    { id: 'o2000000', seededStatus: 'claimed' },
    { id: 'o3000000', seededStatus: 'sent' },
  ],
  unseeded: {},
};

const COUNTS = expectedErasureCounts(SEED);
const OUTCOME: ErasureOutcome = {
  status: 'erased',
  erasedAt: ERASED_MS,
  deadline: DEADLINE_MS,
  counts: COUNTS,
};
const PERSONAL_TABLES = ERASURE_PLAN.map((rule) => rule.table);

function observation(overrides: Partial<ErasureDrillObservation> = {}): ErasureDrillObservation {
  return {
    remaining: ZERO,
    account: { exists: true, emailNull: true, emailVerifiedNull: true, deletedAtMs: ERASED_MS },
    ledger: {
      erasedAtMs: ERASED_MS,
      deadlineAtMs: DEADLINE_MS,
      planVersion: ERASURE_PLAN_VERSION,
      counts: { ...COUNTS },
    },
    outbox: SEED.outbox.map((row) => ({
      id: row.id,
      status: row.seededStatus === 'sent' ? 'sent' : 'cancelled_erasure',
      watchZoneIdNull: true,
      channelSubscriptionIdNull: true,
      templateParamKeys: [],
      pseudonymizedAtMs: ERASED_MS,
    })),
    erasedWriteRefused: true,
    personalTables: PERSONAL_TABLES,
    ...overrides,
  };
}

function statusOf(checks: readonly { id: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
}

describe('expectedErasureCounts', () => {
  it('counts open outbox rows as cancelled and every row as pseudonymized', () => {
    expect(COUNTS).toMatchObject({
      outboxCancelled: 2,
      outboxPseudonymized: 3,
      zones: 4,
      decisionLog: 2,
      digestLog: 3,
    });
  });
});

describe('verifyErasure', () => {
  it('passes a clean erasure: every plan table, the counts, the ledger and the write probe', () => {
    const checks = verifyErasure(SEED, OUTCOME, observation());
    expect(checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      'plan_covers_registry',
      'erasure_outcome',
      'erasure_counts',
      ...ERASURE_PLAN.map((rule) => `table_${rule.table}`),
      'erased_write_refused',
    ]);
  });

  it('fails a personal table the plan does not name', () => {
    const checks = verifyErasure(
      SEED,
      OUTCOME,
      observation({ personalTables: [...PERSONAL_TABLES, 'new_personal'] }),
    );
    expect(checks[0]).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('new_personal') as unknown,
    });
  });

  it('fails a surviving row, a live outbox row and a missing tombstone', () => {
    const checks = verifyErasure(
      SEED,
      OUTCOME,
      observation({
        remaining: { ...ZERO, watch_zones: 1 },
        outbox: [
          {
            id: 'o1000000',
            status: 'pending',
            watchZoneIdNull: false,
            channelSubscriptionIdNull: true,
            templateParamKeys: ['place_name'],
            pseudonymizedAtMs: null,
          },
        ],
        account: { exists: false, emailNull: true, emailVerifiedNull: true, deletedAtMs: null },
      }),
    );
    const status = statusOf(checks);
    expect(status).toMatchObject({
      table_watch_zones: 'fail',
      table_alert_outbox: 'fail',
      table_accounts: 'fail',
    });
    const outbox = checks.find((c) => c.id === 'table_alert_outbox');
    expect(outbox?.detail).toContain('pending → pending, expected cancelled_erasure');
    expect(outbox?.detail).toContain('o2000000 is gone');
    expect(outbox?.detail).toContain('place_name');
  });

  it('marks unseeded legs not_run, never pass', () => {
    const seed: ErasureDrillSeed = {
      ...SEED,
      rows: { ...ROWS, alerts_shadow: 0, alert_decision_log: 0 },
      outbox: [],
      unseeded: {
        alerts_shadow: 'no events_shadow row',
        alert_outbox: 'no fire event',
        alert_decision_log: 'no fire event',
      },
    };
    const outcome: ErasureOutcome = { ...OUTCOME, counts: expectedErasureCounts(seed) };
    const checks = verifyErasure(
      seed,
      outcome,
      observation({
        outbox: [],
        ledger: { ...observation().ledger!, counts: { ...outcome.counts } },
      }),
    );
    expect(statusOf(checks)).toMatchObject({
      table_alerts_shadow: 'not_run',
      table_alert_decision_log: 'not_run',
      table_alert_outbox: 'not_run',
      erasure_counts: 'pass',
    });
    expect(checks.find((c) => c.id === 'table_alert_outbox')?.detail).toContain('no fire event');
  });

  it('fails a non-erased outcome, a count mismatch and a wrong ledger', () => {
    expect(
      statusOf(verifyErasure(SEED, { status: 'missing' }, observation()))['erasure_outcome'],
    ).toBe('fail');
    const miscounted: ErasureOutcome = { ...OUTCOME, counts: { ...COUNTS, sessions: 0 } };
    expect(statusOf(verifyErasure(SEED, miscounted, observation()))).toMatchObject({
      erasure_counts: 'fail',
      table_erasure_requests: 'fail',
    });
    const ledger = { ...observation().ledger!, planVersion: 'erasure_plan_v1' };
    expect(
      statusOf(verifyErasure(SEED, OUTCOME, observation({ ledger })))['table_erasure_requests'],
    ).toBe('fail');
    expect(
      statusOf(verifyErasure(SEED, OUTCOME, observation({ ledger: null })))[
        'table_erasure_requests'
      ],
    ).toBe('fail');
  });

  it('reports the write probe as fail when the write went through, not_run when it could not run', () => {
    expect(
      statusOf(verifyErasure(SEED, OUTCOME, observation({ erasedWriteRefused: false })))[
        'erased_write_refused'
      ],
    ).toBe('fail');
    expect(
      statusOf(verifyErasure(SEED, OUTCOME, observation({ erasedWriteRefused: null })))[
        'erased_write_refused'
      ],
    ).toBe('not_run');
  });
});

describe('verifyBackupErasure', () => {
  const personal = (daysAgo: number, tier: 'daily' | 'weekly' = 'daily') => {
    const key = backupObjectKey('personal', tier, ERASED_MS - daysAgo * DAY).key;
    return { key, lastModifiedMs: ERASED_MS - daysAgo * DAY, sizeBytes: 1 };
  };

  it('passes the policy and a bucket of young personal dailies', () => {
    const checks = verifyBackupErasure({
      erasedAtMs: ERASED_MS,
      nowMs: ERASED_MS,
      personalListing: [personal(1), personal(27)],
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['backup_policy_within_horizon', 'pass'],
      ['backup_artifacts_expire_by_deadline', 'pass'],
      ['backup_bucket_inside_horizon', 'pass'],
    ]);
  });

  it('fails a personal weekly (no retention tier for personal) and an artifact past the horizon', () => {
    const checks = verifyBackupErasure({
      erasedAtMs: ERASED_MS,
      nowMs: ERASED_MS,
      personalListing: [personal(3, 'weekly'), personal(31)],
    });
    const status = statusOf(checks);
    expect(status['backup_artifacts_expire_by_deadline']).toBe('fail');
    expect(status['backup_bucket_inside_horizon']).toBe('fail');
  });

  it('ignores artifacts taken after the erasure', () => {
    const later = backupObjectKey('personal', 'daily', ERASED_MS + DAY).key;
    const checks = verifyBackupErasure({
      erasedAtMs: ERASED_MS,
      nowMs: ERASED_MS + 2 * DAY,
      personalListing: [{ key: later, lastModifiedMs: ERASED_MS + DAY, sizeBytes: 1 }],
    });
    expect(checks[1]?.detail).toMatch(/^0 pre-erasure/);
  });

  it('is not_run for the bucket legs without a listing', () => {
    const checks = verifyBackupErasure({
      erasedAtMs: ERASED_MS,
      nowMs: ERASED_MS,
      personalListing: null,
    });
    expect(checks.map((c) => c.status)).toEqual(['pass', 'not_run', 'not_run']);
  });
});
