import { describe, expect, it } from 'vitest';

import {
  createPgMonitorReader,
  MONITOR_SQL,
  type PgMonitorQueryable,
} from './pg-monitor-reader.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

function fakeDb(rows: Record<string, unknown>[]): { db: PgMonitorQueryable; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
      },
    },
  };
}

describe('createPgMonitorReader', () => {
  it('decodes the outbox aggregate and passes the clock instant as the due bound', async () => {
    const { db, calls } = fakeDb([
      {
        pending_count: 3,
        claimed_count: 1,
        oldest_unsent_decided_at: new Date('2026-09-23T09:45:00Z'),
        oldest_claimed_decided_at: new Date('2026-09-23T09:50:00Z'),
        awaiting_count: 0,
        oldest_awaiting_decided_at: null,
      },
    ]);
    const snapshot = await createPgMonitorReader(db).readOutboxQueue(
      Date.parse('2026-09-23T10:00:00Z'),
    );

    expect(calls).toEqual([{ text: MONITOR_SQL.outboxQueue, values: ['2026-09-23T10:00:00Z'] }]);
    expect(snapshot).toEqual({
      pendingCount: 3,
      claimedCount: 1,
      oldestUnsentDecidedAt: Date.parse('2026-09-23T09:45:00Z'),
      oldestClaimedDecidedAt: Date.parse('2026-09-23T09:50:00Z'),
      awaitingApprovalCount: 0,
      oldestAwaitingDecidedAt: null,
    });
  });

  it('decodes the identity aggregate', async () => {
    const { db, calls } = fakeDb([
      { live_runs: 1, pending_batches: 2, oldest_recorded_at: new Date('2026-09-23T08:00:00Z') },
    ]);
    const snapshot = await createPgMonitorReader(db).readIdentityLag(0);
    expect(calls[0]?.values).toEqual(['1970-01-01T00:00:00Z']);
    expect(snapshot).toEqual({
      liveRuns: 1,
      pendingBatches: 2,
      oldestPendingRecordedAt: Date.parse('2026-09-23T08:00:00Z'),
    });
  });

  it('refuses a driver that returns no row or a malformed one', async () => {
    await expect(createPgMonitorReader(fakeDb([]).db).readOutboxQueue(0)).rejects.toThrow(/no row/);
    await expect(
      createPgMonitorReader(
        fakeDb([{ live_runs: '1', pending_batches: 0, oldest_recorded_at: null }]).db,
      ).readIdentityLag(0),
    ).rejects.toThrow(/live_runs/);
  });

  it('is read-only and never touches a user-facing column', () => {
    for (const sql of Object.values(MONITOR_SQL)) {
      expect(sql).toMatch(/^(SELECT|WITH)\b/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/);
      expect(sql).not.toMatch(/template_params|watch_zone_id|channel_subscription_id/);
    }
  });

  it('only counts a pending row once it is due, mirroring the dispatch claim', () => {
    expect(MONITOR_SQL.outboxQueue).toContain(
      "status = 'pending' AND decided_at <= $1::timestamptz",
    );
  });
});
