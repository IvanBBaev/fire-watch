import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import { ERASURE_PLAN_VERSION } from '../../core/erasure/erasure-plan.js';
import {
  ACCOUNT_ERASURE_SQL,
  createPgAccountErasureStore,
  createPgAccountEraser,
  type PgErasureClient,
} from './pg-account-erasure.js';

const AT = epochMsFromIso('2026-09-23T10:00:00Z');
const ACCOUNT = '88888888-0000-4000-8000-000000000001';
const ZONE = '88888888-0000-4000-8000-0000000000a1';

type Key = keyof typeof ACCOUNT_ERASURE_SQL;
type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

/** Answers by statement; anything unlisted gets no rows and rowCount 1. */
function stubPool(answers: Partial<Record<Key, Answer>> = {}) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let released = 0;
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers)) {
    byText.set(ACCOUNT_ERASURE_SQL[key as Key], answer);
  }
  const keyOf = new Map<string, string>(
    Object.entries(ACCOUNT_ERASURE_SQL).map(([key, text]) => [text, key]),
  );
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const answer = byText.get(text);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? 1,
    });
  };
  const client: PgErasureClient = {
    query,
    release() {
      released += 1;
    },
  };
  return {
    queries,
    steps: () => queries.map((q) => keyOf.get(q.text) ?? q.text),
    valuesOf: (key: Key) => queries.find((q) => q.text === ACCOUNT_ERASURE_SQL[key])?.values,
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

const LIVE: Partial<Record<Key, Answer>> = {
  lockAccount: { rows: [{ erased: false, email: 'a@example.org' }], rowCount: 1 },
  lockZones: { rows: [{ id: ZONE }], rowCount: 1 },
  cancelAndPseudonymizeOutbox: { rows: [{ cancelled: 2, pseudonymized: 3 }], rowCount: 1 },
  deleteAlertStates: { rows: [], rowCount: 4 },
  deleteZones: {
    rows: [{ zones: 1, shadow_alerts: 5, decision_log: 3, digest_log: 2 }],
    rowCount: 1,
  },
  deleteChannelConfirmations: { rows: [], rowCount: 3 },
  deleteSubscriptions: { rows: [], rowCount: 1 },
  deleteSessions: { rows: [], rowCount: 2 },
  deleteLinkRequests: { rows: [], rowCount: 0 },
};

describe('createPgAccountEraser', () => {
  it('runs every statement inside one BEGIN … COMMIT, in the core order, and releases', async () => {
    const stub = stubPool(LIVE);
    const outcome = await createPgAccountEraser(stub.pool)(ACCOUNT, AT);
    expect(stub.steps()).toEqual([
      'BEGIN',
      'lockAccount',
      'lockZones',
      'cancelAndPseudonymizeOutbox',
      'deleteAlertStates',
      'deleteZones',
      'deleteChannelConfirmations',
      'deleteSubscriptions',
      'deleteSessions',
      'deleteLinkRequests',
      'tombstoneAccount',
      'recordErasure',
      'COMMIT',
    ]);
    expect(stub.released()).toBe(1);
    expect(outcome).toEqual({
      status: 'erased',
      erasedAt: AT,
      deadline: epochMsFromIso('2026-10-23T10:00:00Z'),
      counts: {
        outboxCancelled: 2,
        outboxPseudonymized: 3,
        alertStates: 4,
        shadowAlerts: 5,
        decisionLog: 3,
        digestLog: 2,
        zones: 1,
        channelConfirmations: 3,
        subscriptions: 1,
        sessions: 2,
        linkRequests: 0,
      },
    });
  });

  it('binds ISO times, the zone array, no retained keys, and the ledger counts as JSON', async () => {
    const stub = stubPool(LIVE);
    await createPgAccountEraser(stub.pool)(ACCOUNT, AT);
    expect(stub.valuesOf('cancelAndPseudonymizeOutbox')).toEqual([
      [ZONE],
      '2026-09-23T10:00:00Z',
      [],
    ]);
    expect(stub.valuesOf('tombstoneAccount')).toEqual([ACCOUNT, '2026-09-23T10:00:00Z']);
    expect(stub.valuesOf('deleteLinkRequests')).toEqual(['a@example.org']);
    const ledger = stub.valuesOf('recordErasure');
    expect(ledger?.slice(0, 4)).toEqual([
      ACCOUNT,
      '2026-09-23T10:00:00Z',
      '2026-10-23T10:00:00Z',
      ERASURE_PLAN_VERSION,
    ]);
    expect(JSON.parse(String(ledger?.[4]))).toMatchObject({ zones: 1, outboxCancelled: 2 });
  });

  it('rolls back and releases when a statement fails, and rethrows the original error', async () => {
    const stub = stubPool({ ...LIVE, deleteSessions: new Error('connection reset') });
    await expect(createPgAccountEraser(stub.pool)(ACCOUNT, AT)).rejects.toThrow('connection reset');
    expect(stub.steps().at(-1)).toBe('ROLLBACK');
    expect(stub.steps()).not.toContain('COMMIT');
    expect(stub.steps()).not.toContain('tombstoneAccount');
    expect(stub.released()).toBe(1);
  });

  it('commits after the lock alone for a missing or an already-erased account', async () => {
    const missing = stubPool({ lockAccount: { rows: [], rowCount: 0 } });
    expect(await createPgAccountEraser(missing.pool)(ACCOUNT, AT)).toEqual({ status: 'missing' });
    expect(missing.steps()).toEqual(['BEGIN', 'lockAccount', 'COMMIT']);

    const erased = stubPool({
      lockAccount: { rows: [{ erased: true, email: null }], rowCount: 1 },
    });
    expect(await createPgAccountEraser(erased.pool)(ACCOUNT, AT)).toEqual({
      status: 'already_erased',
    });
    expect(erased.steps()).toEqual(['BEGIN', 'lockAccount', 'COMMIT']);
  });

  it('rolls back when the tombstone does not write exactly one row', async () => {
    const stub = stubPool({ ...LIVE, tombstoneAccount: { rows: [], rowCount: 0 } });
    await expect(createPgAccountEraser(stub.pool)(ACCOUNT, AT)).rejects.toThrow(/tombstone/);
    expect(stub.steps()).toContain('ROLLBACK');
    expect(stub.steps()).not.toContain('recordErasure');
  });
});

describe('createPgAccountErasureStore', () => {
  it('refuses a zone deletion that removed fewer zones than it locked', async () => {
    const stub = stubPool({
      deleteZones: {
        rows: [{ zones: 0, shadow_alerts: 0, decision_log: 0, digest_log: 0 }],
        rowCount: 1,
      },
    });
    await expect(createPgAccountErasureStore(stub.pool).deleteZones([ZONE])).rejects.toThrow(
      /removed 0 of 1/,
    );
  });

  it('refuses a non-text address rather than guessing', async () => {
    const stub = stubPool({ lockAccount: { rows: [{ erased: false, email: 42 }], rowCount: 1 } });
    await expect(createPgAccountErasureStore(stub.pool).lockAccount(ACCOUNT)).rejects.toThrow(
      TypeError,
    );
  });

  it('reads a NULL address as live with no email', async () => {
    const stub = stubPool({ lockAccount: { rows: [{ erased: false, email: null }], rowCount: 1 } });
    expect(await createPgAccountErasureStore(stub.pool).lockAccount(ACCOUNT)).toEqual({
      state: 'live',
      email: null,
    });
  });
});

describe('ACCOUNT_ERASURE_SQL shape', () => {
  it('locks account, zones and outbox rows with FOR UPDATE and never skips a locked row', () => {
    expect(ACCOUNT_ERASURE_SQL.lockAccount).toMatch(/FOR UPDATE/);
    expect(ACCOUNT_ERASURE_SQL.lockZones).toMatch(/ORDER BY id\s+FOR UPDATE/);
    expect(ACCOUNT_ERASURE_SQL.cancelAndPseudonymizeOutbox).toMatch(/ORDER BY id\s+FOR UPDATE/);
    for (const text of Object.values(ACCOUNT_ERASURE_SQL)) {
      expect(text).not.toMatch(/SKIP LOCKED|NOWAIT/);
    }
  });

  it('cancels exactly the unsent statuses and destroys the zone and endpoint references', () => {
    const sql = ACCOUNT_ERASURE_SQL.cancelAndPseudonymizeOutbox;
    expect(sql).toContain("IN ('pending', 'awaiting_approval', 'claimed')");
    expect(sql).toContain("'cancelled_erasure'");
    expect(sql).toMatch(/watch_zone_id = NULL/);
    expect(sql).toMatch(/channel_subscription_id = NULL/);
    expect(sql).toMatch(/pseudonymized_at = \$2::timestamptz/);
  });

  it('hashes the account id in SQL and never binds it into a ledger column as plain text', () => {
    expect(ACCOUNT_ERASURE_SQL.recordErasure).toMatch(/sha256\(convert_to\(\$1::text, 'UTF8'\)\)/);
    expect(ACCOUNT_ERASURE_SQL.tombstoneAccount).toMatch(/email = NULL/);
    expect(ACCOUNT_ERASURE_SQL.tombstoneAccount).toMatch(/deleted_at IS NULL/);
  });
});
