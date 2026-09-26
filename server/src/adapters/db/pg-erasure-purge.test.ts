import { describe, expect, it } from 'vitest';

import { PURGE_TARGETS } from '../../core/erasure/purge-plan.js';
import { createPgErasurePurge, ERASURE_PURGE_SQL } from './pg-erasure-purge.js';

const CUTOFF = '2026-08-24T03:00:00Z';
const FUNCTION_TARGETS: readonly string[] = [
  'erasure_ledger',
  'alert_decision_log',
  'alert_digest_log',
];

function stubDb(result: { rows: Record<string, unknown>[]; rowCount: number | null }) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  return {
    queries,
    db: {
      query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        return Promise.resolve({ rows: result.rows as Row[], rowCount: result.rowCount });
      },
    },
  };
}

describe('createPgErasurePurge', () => {
  it('purges the ledger only through the horizon-guarded function and reads its count', async () => {
    const stub = stubDb({ rows: [{ purged: 7 }], rowCount: 1 });
    expect(await createPgErasurePurge(stub.db).purge('erasure_ledger', CUTOFF, 50)).toBe(7);
    expect(stub.queries).toEqual([
      { text: ERASURE_PURGE_SQL.erasure_ledger, values: [CUTOFF, 50] },
    ]);
    expect(ERASURE_PURGE_SQL.erasure_ledger).toMatch(/purge_erasure_ledger\(/);
    expect(ERASURE_PURGE_SQL.erasure_ledger).not.toMatch(/DELETE/);
  });

  it('purges the decision log only through its guarded function and reads its count', async () => {
    const stub = stubDb({ rows: [{ purged: 4 }], rowCount: 1 });
    expect(await createPgErasurePurge(stub.db).purge('alert_decision_log', CUTOFF, 50)).toBe(4);
    expect(stub.queries).toEqual([
      { text: ERASURE_PURGE_SQL.alert_decision_log, values: [CUTOFF, 50] },
    ]);
    expect(ERASURE_PURGE_SQL.alert_decision_log).toMatch(/purge_alert_decision_log\(/);
    expect(ERASURE_PURGE_SQL.alert_decision_log).not.toMatch(/DELETE/);
  });

  it('purges the digest log only through its watermark-keeping function', async () => {
    const stub = stubDb({ rows: [{ purged: 2 }], rowCount: 1 });
    expect(await createPgErasurePurge(stub.db).purge('alert_digest_log', CUTOFF, 50)).toBe(2);
    expect(stub.queries).toEqual([
      { text: ERASURE_PURGE_SQL.alert_digest_log, values: [CUTOFF, 50] },
    ]);
    expect(ERASURE_PURGE_SQL.alert_digest_log).toMatch(/purge_alert_digest_log\(/);
    expect(ERASURE_PURGE_SQL.alert_digest_log).not.toMatch(/DELETE/);
  });

  it('reads the row count for the other targets', async () => {
    for (const target of PURGE_TARGETS.filter((t) => !FUNCTION_TARGETS.includes(t))) {
      const stub = stubDb({ rows: [], rowCount: 3 });
      expect(await createPgErasurePurge(stub.db).purge(target, CUTOFF, 10)).toBe(3);
      expect(stub.queries[0]?.values).toEqual([CUTOFF, 10]);
    }
  });

  it('bounds every statement by the limit', () => {
    for (const target of PURGE_TARGETS.filter((t) => !FUNCTION_TARGETS.includes(t))) {
      expect(ERASURE_PURGE_SQL[target]).toMatch(/LIMIT \$2::integer/);
    }
  });

  it('deletes only scrubbed tombstones with nothing left under them', () => {
    const sql = ERASURE_PURGE_SQL.account_tombstones;
    expect(sql).toMatch(/deleted_at < \$1/);
    expect(sql).toMatch(/email IS NULL/);
    for (const table of [
      'watch_zones',
      'channel_subscriptions',
      'channel_confirmations',
      'account_sessions',
    ]) {
      expect(sql).toContain(`NOT EXISTS (SELECT 1 FROM ${table}`);
    }
  });

  it('refuses a limit that is not a positive integer before querying', async () => {
    const stub = stubDb({ rows: [], rowCount: 0 });
    const purge = createPgErasurePurge(stub.db);
    await expect(purge.purge('ended_sessions', CUTOFF, 0)).rejects.toThrow(RangeError);
    await expect(purge.purge('ended_sessions', CUTOFF, 1.5)).rejects.toThrow(RangeError);
    expect(stub.queries).toEqual([]);
  });

  it('refuses a ledger answer with no row', async () => {
    const stub = stubDb({ rows: [], rowCount: 0 });
    await expect(createPgErasurePurge(stub.db).purge('erasure_ledger', CUTOFF, 1)).rejects.toThrow(
      /no row/,
    );
    await expect(
      createPgErasurePurge(stub.db).purge('alert_decision_log', CUTOFF, 1),
    ).rejects.toThrow(/no row/);
  });
});
