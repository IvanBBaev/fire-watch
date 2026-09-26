import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { ErasureDrillSeed } from '../../core/drills/erasure-verification.js';
import type { PgErasureClient } from './pg-account-erasure.js';
import { ERASURE_DRILL_SQL, observeErasure, seedDrillAccount } from './pg-erasure-drill.js';

const NOW = epochMsFromIso('2026-09-25T10:00:00Z');
const ACCOUNT = '99999999-0000-4000-8000-000000000001';
const ZONES = ['a1', 'a2', 'a3', 'a4'].map((z) => `99999999-0000-4000-8000-0000000000${z}`);
const EMAIL = 'drill-test@example.invalid';

type Key = keyof typeof ERASURE_DRILL_SQL | 'BEGIN' | 'COMMIT' | 'ROLLBACK';
type Answer = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

function stubPool(answers: Partial<Record<Key, Answer>>) {
  const keyOf = new Map<string, Key>(
    Object.entries(ERASURE_DRILL_SQL).map(([key, text]) => [text, key as Key]),
  );
  const calls: { key: string; values: readonly unknown[] }[] = [];
  let released = 0;
  let outboxId = 0;
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    const key = keyOf.get(text) ?? (text as Key);
    calls.push({ key, values });
    if (key === 'insertOutboxRow') {
      outboxId += 1;
      return Promise.resolve({ rows: [{ id: String(outboxId) }] as unknown as Row[], rowCount: 1 });
    }
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? answer?.rows.length ?? 1,
    });
  };
  const client: PgErasureClient = {
    query,
    release() {
      released += 1;
    },
  };
  return {
    calls,
    keys: () => calls.map((c) => c.key),
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

const BASE: Partial<Record<Key, Answer>> = {
  insertAccount: { rows: [{ id: ACCOUNT }] },
  insertSubscription: { rows: [{ id: 'sub-1' }] },
  insertZones: { rows: ZONES.map((id) => ({ id })) },
};

describe('seedDrillAccount', () => {
  it('seeds every leg in one transaction when a fire event and a shadow event exist', async () => {
    const stub = stubPool({
      ...BASE,
      newestFireEvent: { rows: [{ id: '42', seq: '7' }] },
      newestShadowEvent: { rows: [{ candidate_version: 'clustering_v2', shadow_key: 'k1' }] },
    });
    const seed = await seedDrillAccount(stub.pool, { nowMs: NOW, email: EMAIL });

    expect(seed).toEqual({
      accountId: ACCOUNT,
      email: EMAIL,
      zoneIds: ZONES,
      rows: {
        alert_states: 1,
        alerts_shadow: 1,
        alert_decision_log: 2,
        alert_digest_log: 2,
        watch_zones: 4,
        channel_confirmations: 2,
        channel_subscriptions: 1,
        account_sessions: 1,
        auth_link_requests: 1,
      },
      outbox: [
        { id: '1', seededStatus: 'sent' },
        { id: '2', seededStatus: 'claimed' },
        { id: '3', seededStatus: 'pending' },
      ],
      unseeded: {},
    });
    expect(stub.keys()[0]).toBe('BEGIN');
    expect(stub.keys().at(-1)).toBe('COMMIT');
    expect(stub.released()).toBe(1);
    const decisions = stub.calls.find((c) => c.key === 'insertDecisions');
    expect(decisions?.values).toEqual([
      ZONES[3],
      ZONES[0],
      '42',
      '7',
      'alert_gating_v1',
      '2026-09-25T10:00:00Z',
    ]);
    const digest = stub.calls.find((c) => c.key === 'insertDigestDecisions');
    expect(digest?.values).toEqual([ZONES[0], 'digest_params_v1', '2026-09-25T10:00:00Z']);
    const sent = stub.calls.filter((c) => c.key === 'insertOutboxRow').map((c) => c.values[8]);
    expect(sent).toEqual(['2026-09-25T10:00:00Z', null, null]);
    // Migration 015's CHECK: a claimed row carries its lease (the drill's first real run
    // failed on exactly this).
    const leases = stub.calls.filter((c) => c.key === 'insertOutboxRow').map((c) => c.values[9]);
    expect(leases).toEqual(['2026-09-25T10:00:00Z', '2026-09-25T10:00:00Z', null]);
  });

  it('reports the fire-keyed legs unseeded rather than inventing an event', async () => {
    const stub = stubPool(BASE);
    const seed = await seedDrillAccount(stub.pool, { nowMs: NOW, email: EMAIL });

    expect(seed.rows.alert_states).toBe(0);
    expect(seed.rows.alert_decision_log).toBe(0);
    expect(seed.rows.alerts_shadow).toBe(0);
    // The digest leg needs a zone, not a fire: it is seeded either way.
    expect(seed.rows.alert_digest_log).toBe(2);
    expect(seed.outbox).toEqual([]);
    expect(Object.keys(seed.unseeded).sort()).toEqual([
      'alert_decision_log',
      'alert_outbox',
      'alert_states',
      'alerts_shadow',
    ]);
    expect(stub.keys()).not.toContain('insertOutboxRow');
  });

  it('refuses an address outside example.invalid', async () => {
    const stub = stubPool(BASE);
    await expect(
      seedDrillAccount(stub.pool, { nowMs: NOW, email: 'someone@example.org' }),
    ).rejects.toThrow(/example\.invalid/);
    expect(stub.calls).toEqual([]);
  });

  it('rolls back and releases when a statement fails', async () => {
    const stub = stubPool({ ...BASE, insertSession: new Error('boom') });
    await expect(seedDrillAccount(stub.pool, { nowMs: NOW, email: EMAIL })).rejects.toThrow('boom');
    expect(stub.keys()).toContain('ROLLBACK');
    expect(stub.keys()).not.toContain('COMMIT');
    expect(stub.released()).toBe(1);
  });

  it('generates a .invalid address by default', async () => {
    const stub = stubPool(BASE);
    const seed = await seedDrillAccount(stub.pool, { nowMs: NOW });
    expect(seed.email).toMatch(/^drill-[0-9a-f-]{36}@example\.invalid$/);
  });
});

const SEED: ErasureDrillSeed = {
  accountId: ACCOUNT,
  email: EMAIL,
  zoneIds: ZONES,
  rows: {
    alert_states: 1,
    alerts_shadow: 0,
    alert_decision_log: 2,
    alert_digest_log: 2,
    watch_zones: 4,
    channel_confirmations: 2,
    channel_subscriptions: 1,
    account_sessions: 1,
    auth_link_requests: 1,
  },
  outbox: [{ id: '1', seededStatus: 'sent' }],
  unseeded: {},
};

const ZERO_REMAINING = {
  alert_states: 0,
  alerts_shadow: 0,
  alert_decision_log: 0,
  alert_digest_log: 0,
  watch_zones: 0,
  channel_confirmations: 0,
  channel_subscriptions: 0,
  account_sessions: 0,
  auth_link_requests: 0,
};

describe('observeErasure', () => {
  it('reads every table, the tombstone, the ledger and the outbox, and probes a write', async () => {
    const erasedAt = new Date(NOW);
    const stub = stubPool({
      remaining: { rows: [ZERO_REMAINING] },
      accountRow: {
        rows: [{ email_null: true, email_verified_null: true, deleted_at: erasedAt }],
      },
      ledgerRow: {
        rows: [
          {
            erased_at: erasedAt,
            deadline_at: new Date(NOW + 30 * 86_400_000),
            plan_version: 'erasure_plan_v3',
            counts: { zones: 4 },
          },
        ],
      },
      outboxRows: {
        rows: [
          {
            id: '1',
            status: 'sent',
            watch_zone_id_null: true,
            channel_subscription_id_null: true,
            template_params: {},
            pseudonymized_at: erasedAt,
          },
        ],
      },
      personalTables: { rows: [{ table_name: 'accounts' }, { table_name: 'watch_zones' }] },
      probeWrite: Object.assign(
        new Error('account is erased; channel_subscriptions cannot reference it'),
        { code: '23503' },
      ),
    });

    const observation = await observeErasure(stub.pool, SEED);

    expect(observation).toEqual({
      remaining: ZERO_REMAINING,
      account: { exists: true, emailNull: true, emailVerifiedNull: true, deletedAtMs: NOW },
      ledger: {
        erasedAtMs: NOW,
        deadlineAtMs: NOW + 30 * 86_400_000,
        planVersion: 'erasure_plan_v3',
        counts: { zones: 4 },
      },
      outbox: [
        {
          id: '1',
          status: 'sent',
          watchZoneIdNull: true,
          channelSubscriptionIdNull: true,
          templateParamKeys: [],
          pseudonymizedAtMs: NOW,
        },
      ],
      erasedWriteRefused: true,
      personalTables: ['accounts', 'watch_zones'],
    });
    expect(stub.calls.find((c) => c.key === 'remaining')?.values).toEqual([ACCOUNT, ZONES, EMAIL]);
    expect(stub.keys().slice(-3)).toEqual(['BEGIN', 'probeWrite', 'ROLLBACK']);
  });

  it('reports an accepted write as not refused, and a missing account and ledger as such', async () => {
    const stub = stubPool({ remaining: { rows: [ZERO_REMAINING] } });
    const observation = await observeErasure(stub.pool, SEED);
    expect(observation.erasedWriteRefused).toBe(false);
    expect(observation.account.exists).toBe(false);
    expect(observation.ledger).toBeNull();
    expect(stub.keys().at(-1)).toBe('ROLLBACK');
  });

  it('does not count a refusal for another reason (a missing grant) as the guard', async () => {
    const stub = stubPool({
      remaining: { rows: [ZERO_REMAINING] },
      probeWrite: Object.assign(new Error('permission denied for table channel_subscriptions'), {
        code: '42501',
      }),
    });
    const observation = await observeErasure(stub.pool, SEED);
    expect(observation.erasedWriteRefused).toBeNull();
    expect(stub.keys().at(-1)).toBe('ROLLBACK');
  });

  it('reports the probe as not run when its transaction cannot start', async () => {
    const stub = stubPool({ remaining: { rows: [ZERO_REMAINING] }, BEGIN: new Error('down') });
    const observation = await observeErasure(stub.pool, SEED);
    expect(observation.erasedWriteRefused).toBeNull();
    expect(stub.released()).toBe(1);
  });
});
