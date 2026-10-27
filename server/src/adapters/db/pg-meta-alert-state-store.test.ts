import { describe, expect, it } from 'vitest';

import { INITIAL_META_ALERT_STATE } from '../../core/monitoring/meta-alert-evaluator.js';
import type { StoredMetaAlertStates } from '../../core/monitoring/meta-alert-memory.js';
import { epochMsFromIso, isoFromEpochMs } from '../../core/ports/clock.js';
import {
  createPgMetaAlertStateStore,
  META_ALERT_STATE_SQL,
  type PgMetaAlertStateClient,
} from './pg-meta-alert-state-store.js';

const AT = '2026-10-27T10:00:00.000Z';

class FakeClient implements PgMetaAlertStateClient {
  readonly calls: { text: string; values?: readonly unknown[] }[] = [];
  released = 0;
  rows: Record<string, unknown>[] = [];
  failOn: string | null = null;
  rollbackFails = false;

  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.calls.push(values === undefined ? { text } : { text, values });
    if (this.failOn !== null && text === this.failOn) return Promise.reject(new Error('pg down'));
    if (this.rollbackFails && text === 'ROLLBACK') {
      return Promise.reject(new Error('connection lost'));
    }
    const rows = (text === META_ALERT_STATE_SQL.select ? this.rows : []) as Row[];
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  release(): void {
    this.released += 1;
  }

  texts(): string[] {
    return this.calls.map((call) => call.text);
  }
}

function store(client: FakeClient) {
  return createPgMetaAlertStateStore({ connect: () => Promise.resolve(client) });
}

describe('createPgMetaAlertStateStore', () => {
  it('locks, reads and decodes the rows, upserts the decision, commits and releases', async () => {
    const client = new FakeClient();
    client.rows = [
      {
        key: 'outbox_queue_oldest_seconds',
        paging: true,
        paging_since: new Date('2026-10-27T09:55:00.000Z'),
        breach_streak: 3,
        clear_streak: 0,
        evaluated_at: new Date('2026-10-27T09:59:00.000Z'),
      },
    ];
    let seen: StoredMetaAlertStates | null = null;
    const result = await store(client).update((stored) => {
      seen = stored;
      return {
        write: new Map([
          [
            'outbox_pending_rows',
            { state: INITIAL_META_ALERT_STATE, evaluatedAt: epochMsFromIso(AT) },
          ],
        ]),
        result: 'decided',
      };
    });

    expect(result).toBe('decided');
    expect(seen).toEqual(
      new Map([
        [
          'outbox_queue_oldest_seconds',
          {
            state: {
              paging: true,
              breachStreak: 3,
              clearStreak: 0,
              pagingSince: epochMsFromIso('2026-10-27T09:55:00.000Z'),
            },
            evaluatedAt: epochMsFromIso('2026-10-27T09:59:00.000Z'),
          },
        ],
      ]),
    );
    expect(client.texts()).toEqual([
      'BEGIN',
      META_ALERT_STATE_SQL.lock,
      META_ALERT_STATE_SQL.select,
      META_ALERT_STATE_SQL.upsert,
      'COMMIT',
    ]);
    expect(META_ALERT_STATE_SQL.lock).toContain('pg_advisory_xact_lock(7036, 0)');
    expect(client.calls[3]?.values).toEqual([
      ['outbox_pending_rows'],
      [false],
      [null],
      [0],
      [0],
      [isoFromEpochMs(epochMsFromIso(AT))],
    ]);
    expect(client.released).toBe(1);
  });

  it('writes nothing when the decision holds', async () => {
    const client = new FakeClient();
    await store(client).update(() => ({ write: null, result: undefined }));
    expect(client.texts()).toEqual([
      'BEGIN',
      META_ALERT_STATE_SQL.lock,
      META_ALERT_STATE_SQL.select,
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows when the decision throws, and still releases', async () => {
    const client = new FakeClient();
    await expect(
      store(client).update(() => {
        throw new RangeError('bad rule');
      }),
    ).rejects.toThrow('bad rule');
    expect(client.texts()).toEqual([
      'BEGIN',
      META_ALERT_STATE_SQL.lock,
      META_ALERT_STATE_SQL.select,
      'ROLLBACK',
    ]);
    expect(client.released).toBe(1);
  });

  it('keeps the original error when the rollback itself fails', async () => {
    const client = new FakeClient();
    client.failOn = META_ALERT_STATE_SQL.select;
    client.rollbackFails = true;
    await expect(store(client).update(() => ({ write: null, result: 1 }))).rejects.toThrow(
      'pg down',
    );
    expect(client.released).toBe(1);
  });

  it('refuses a row it cannot decode', async () => {
    const client = new FakeClient();
    client.rows = [
      {
        key: 'outbox_queue_oldest_seconds',
        paging: 'yes',
        paging_since: null,
        breach_streak: 0,
        clear_streak: 0,
        evaluated_at: new Date(AT),
      },
    ];
    await expect(store(client).update(() => ({ write: null, result: 1 }))).rejects.toThrow();
    expect(client.texts().at(-1)).toBe('ROLLBACK');
  });
});
