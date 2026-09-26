import { describe, expect, it } from 'vitest';

import type { ErasureOutcome } from '../erasure/erase-account.js';
import { ERASURE_PLAN, ERASURE_PLAN_VERSION } from '../erasure/erasure-plan.js';
import { epochMsFromIso, VirtualClock, type EpochMs } from '../ports/clock.js';
import { drillVerdict } from './drill-record.js';
import { runErasureDrill, type ErasureDrillDeps } from './erasure-drill.js';
import {
  expectedErasureCounts,
  type DeletedTable,
  type ErasureDrillObservation,
  type ErasureDrillSeed,
} from './erasure-verification.js';

const DAY = 86_400_000;
const START = '2026-09-25T10:00:00Z';

const ROWS: Record<DeletedTable, number> = {
  alert_states: 1,
  alerts_shadow: 1,
  alert_decision_log: 1,
  alert_digest_log: 1,
  watch_zones: 2,
  channel_confirmations: 1,
  channel_subscriptions: 1,
  account_sessions: 1,
  auth_link_requests: 1,
};

const SEED: ErasureDrillSeed = {
  accountId: 'a0000000-0000-4000-8000-000000000001',
  email: 'drill-x@example.invalid',
  zoneIds: ['z1', 'z2'],
  rows: ROWS,
  outbox: [{ id: 'o1', seededStatus: 'pending' }],
  unseeded: {},
};

function fakes(clock: VirtualClock, overrides: Partial<ErasureDrillDeps> = {}): ErasureDrillDeps {
  let erasedAt: EpochMs = 0;
  const counts = expectedErasureCounts(SEED);
  return {
    clock,
    seed: () => {
      clock.advanceMs(200);
      return Promise.resolve(SEED);
    },
    erase: (_accountId, atMs) => {
      erasedAt = atMs;
      clock.advanceMs(100);
      const outcome: ErasureOutcome = {
        status: 'erased',
        erasedAt: atMs,
        deadline: atMs + 30 * DAY,
        counts,
      };
      return Promise.resolve(outcome);
    },
    observe: (): Promise<ErasureDrillObservation> =>
      Promise.resolve({
        remaining: Object.fromEntries(Object.keys(ROWS).map((t) => [t, 0])) as Record<
          DeletedTable,
          number
        >,
        account: { exists: true, emailNull: true, emailVerifiedNull: true, deletedAtMs: erasedAt },
        ledger: {
          erasedAtMs: erasedAt,
          deadlineAtMs: erasedAt + 30 * DAY,
          planVersion: ERASURE_PLAN_VERSION,
          counts: { ...counts },
        },
        outbox: [
          {
            id: 'o1',
            status: 'cancelled_erasure',
            watchZoneIdNull: true,
            channelSubscriptionIdNull: true,
            templateParamKeys: [],
            pseudonymizedAtMs: erasedAt,
          },
        ],
        erasedWriteRefused: true,
        personalTables: ERASURE_PLAN.map((rule) => rule.table),
      }),
    listPersonalBackups: () => Promise.resolve([]),
    ...overrides,
  };
}

const OPTIONS = {
  environment: 'staging',
  target: { database_host: 'db.staging' },
  targetOverride: null,
};

describe('runErasureDrill', () => {
  it('passes a clean drill with a backup audit, erasing at the instant after the seed', async () => {
    const clock = new VirtualClock(START);
    const record = await runErasureDrill(OPTIONS, fakes(clock));
    expect(record.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(drillVerdict(record)).toBe('passed');
    expect(record.facts['erased_at']).toBe('2026-09-25T10:00:00.200Z');
    expect(record.steps.map((s) => [s.id, s.status])).toEqual([
      ['seed_account', 'passed'],
      ['erase_account', 'passed'],
      ['observe_live_database', 'passed'],
      ['audit_backup_retention', 'passed'],
    ]);
    expect(record.rto).toBeNull();
  });

  it('is incomplete without a backup store: the audit is skipped and the bucket legs not_run', async () => {
    const record = await runErasureDrill(
      OPTIONS,
      fakes(new VirtualClock(START), { listPersonalBackups: null }),
    );
    expect(record.steps.at(-1)).toMatchObject({ id: 'audit_backup_retention', status: 'skipped' });
    expect(drillVerdict(record)).toBe('incomplete');
  });

  it('turns unseeded legs into findings and not_run checks', async () => {
    const seed: ErasureDrillSeed = {
      ...SEED,
      rows: { ...ROWS, alerts_shadow: 0 },
      unseeded: { alerts_shadow: 'no events_shadow row to hang a shadow alert on' },
    };
    const record = await runErasureDrill(
      OPTIONS,
      fakes(new VirtualClock(START), { seed: () => Promise.resolve(seed) }),
    );
    expect(record.findings).toContain(
      'alerts_shadow not seeded: no events_shadow row to hang a shadow alert on',
    );
    expect(record.checks.find((c) => c.id === 'table_alerts_shadow')?.status).toBe('not_run');
  });

  it('records a thrown eraser as a failed step and still returns a record', async () => {
    const record = await runErasureDrill(
      OPTIONS,
      fakes(new VirtualClock(START), {
        erase: () => Promise.reject(new Error('deadlock detected')),
      }),
    );
    expect(record.steps.find((s) => s.id === 'erase_account')?.status).toBe('failed');
    expect(record.findings).toContain('erasure drill stopped: deadlock detected');
    expect(record.steps.at(-1)).toMatchObject({ status: 'skipped', detail: 'nothing was erased' });
    expect(drillVerdict(record)).toBe('failed');
  });

  it('records a failing backup listing as a finding and the bucket legs not_run', async () => {
    const record = await runErasureDrill(
      { ...OPTIONS, targetOverride: 'confirmed by --confirm-not-production' },
      fakes(new VirtualClock(START), {
        listPersonalBackups: () => Promise.reject(new Error('403')),
      }),
    );
    expect(record.findings).toContain('backup listing failed: 403');
    expect(record.facts['target_check']).toContain('--confirm-not-production');
    expect(record.checks.find((c) => c.id === 'backup_bucket_inside_horizon')?.status).toBe(
      'not_run',
    );
  });

  it('starts and finishes on the clock', async () => {
    const record = await runErasureDrill(OPTIONS, fakes(new VirtualClock(epochMsFromIso(START))));
    expect([record.startedAt, record.finishedAt]).toEqual([
      '2026-09-25T10:00:00Z',
      '2026-09-25T10:00:00.300Z',
    ]);
  });
});
