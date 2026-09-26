import { describe, expect, it } from 'vitest';

import {
  ALERT_DIGEST_SQL,
  appendLogArrays,
  createPgAlertDigestStore,
  decodePair,
  decodeWatermark,
  type PgAlertDigestClient,
  type PgAlertDigestPool,
} from './pg-alert-digest-store.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

/** Records every statement; answers from `respond`, or with no rows. */
function fakePool(
  respond: (text: string) => { rows: Record<string, unknown>[]; rowCount: number | null } = () => ({
    rows: [],
    rowCount: 0,
  }),
) {
  const calls: Call[] = [];
  let released = 0;
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> => {
    calls.push({ text, values });
    // `pg` never throws synchronously from `query`: a failure is a rejected promise.
    try {
      return Promise.resolve(respond(text) as { rows: Row[]; rowCount: number | null });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const client: PgAlertDigestClient = {
    query,
    release: () => {
      released += 1;
    },
  };
  const pool: PgAlertDigestPool = { query, connect: () => Promise.resolve(client) };
  return { pool, calls, released: () => released };
}

describe('createPgAlertDigestStore — one transaction per account', () => {
  it('BEGINs, runs the work on that client, COMMITs and releases', async () => {
    const { pool, calls, released } = fakePool();
    const result = await createPgAlertDigestStore(pool).withAccount('a1', async (tx) => {
      await tx.appendLog([]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls.map((c) => c.text)).toEqual(['BEGIN', 'COMMIT']);
    expect(released()).toBe(1);
  });

  it('ROLLs BACK and rethrows the original error, even if ROLLBACK itself fails', async () => {
    const { pool, calls, released } = fakePool((text) => {
      if (text === 'ROLLBACK') throw new Error('connection gone');
      return { rows: [], rowCount: 0 };
    });
    await expect(
      createPgAlertDigestStore(pool).withAccount('a1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(calls.map((c) => c.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(released()).toBe(1);
  });

  it('takes no fence on clustering_runs — a digest must not wait on identity writes', () => {
    for (const text of Object.values(ALERT_DIGEST_SQL)) {
      expect(text).not.toMatch(/clustering_runs/);
    }
  });
});

describe('the statements', () => {
  it('locks the account row FOR SHARE, against erasure', () => {
    expect(ALERT_DIGEST_SQL.lockAccount).toMatch(
      /FROM accounts[\s\S]*deleted_at IS NULL\s+FOR SHARE$/,
    );
  });

  it('appends idempotently, on migration 018’s unique constraint', () => {
    expect(ALERT_DIGEST_SQL.appendLog).toMatch(
      /ON CONFLICT ON CONSTRAINT alert_digest_log_once_per_window DO NOTHING$/,
    );
  });

  it('never lets a hold move the watermark', () => {
    expect(ALERT_DIGEST_SQL.readWatermark).toMatch(/l\.outcome IN \('send', 'suppress'\)/);
  });

  it('pages accounts after a cursor, and refuses a non-positive page', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ id: 'b' }, { id: 'c' }], rowCount: 2 }));
    const store = createPgAlertDigestStore(pool);
    expect(await store.listAccountsAfter('a', 2)).toEqual(['b', 'c']);
    expect(calls[0]?.values).toEqual(['a', 2]);
    await expect(store.listAccountsAfter(null, 0)).rejects.toThrow(/positive integer/);
  });

  it('reports the rows appendLog actually inserted, and skips an empty append', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 1 }));
    const inserted = await createPgAlertDigestStore(pool).withAccount('a1', async (tx) => [
      await tx.appendLog([]),
      await tx.appendLog([
        {
          zoneId: 'z1',
          windowStartIso: '2026-08-14T06:00:00Z',
          outcome: 'suppress',
          reason: 'nothing_active',
          entryCount: 0,
          ruleVersion: 'digest_params_v1',
          decidedAtIso: '2026-08-14T06:05:00Z',
        },
        {
          zoneId: 'z2',
          windowStartIso: '2026-08-14T06:00:00Z',
          outcome: 'suppress',
          reason: 'nothing_active',
          entryCount: 0,
          ruleVersion: 'digest_params_v1',
          decidedAtIso: '2026-08-14T06:05:00Z',
        },
      ]),
    ]);
    expect(inserted).toEqual([0, 1]);
    expect(calls.filter((c) => c.text === ALERT_DIGEST_SQL.appendLog)).toHaveLength(1);
  });
});

describe('the bound values and decoders', () => {
  it('binds one array per column, in the INSERT’s column order', () => {
    expect(
      appendLogArrays([
        {
          zoneId: 'z1',
          windowStartIso: 'w',
          outcome: 'send',
          reason: 'daily_summary',
          entryCount: 3,
          ruleVersion: 'digest_params_v1',
          decidedAtIso: 'd',
        },
      ]),
    ).toEqual([['z1'], ['w'], ['send'], ['daily_summary'], [3], ['digest_params_v1'], ['d']]);
  });

  it('decodes a pair, keeping absent instants null', () => {
    expect(
      decodePair({
        zone_id: 'z1',
        fire_event_id: '7',
        seq: '41',
        public_id: 'fw-2026-aaaaa',
        lat: 42.61,
        lon: 23.3,
        seeded_at: null,
        last_notified_at: new Date('2026-08-13T10:00:00Z'),
        last_deferred_at: new Date('2026-08-13T23:00:00Z'),
      }),
    ).toEqual({
      zoneId: 'z1',
      fireEventId: '7',
      seq: '41',
      eventPublicId: 'fw-2026-aaaaa',
      centroid: { lat: 42.61, lon: 23.3 },
      seededAtIso: null,
      lastNotifiedAtIso: '2026-08-13T10:00:00Z',
      lastDeferredAtIso: '2026-08-13T23:00:00Z',
    });
  });

  it('refuses a row whose timestamp or coordinate is not what the column promises', () => {
    const row = {
      zone_id: 'z1',
      fire_event_id: '7',
      seq: '41',
      public_id: 'fw-2026-aaaaa',
      lat: 42.61,
      lon: 23.3,
      seeded_at: '2026-08-13',
      last_notified_at: null,
      last_deferred_at: null,
    };
    expect(() => decodePair(row)).toThrow(/seeded_at is not a timestamp/);
    expect(() => decodePair({ ...row, seeded_at: null, lat: '42.61' })).toThrow(/lat/);
  });

  it('decodes the watermark', () => {
    expect(
      decodeWatermark({
        window_start: new Date('2026-08-14T06:00:00Z'),
        decided_at: new Date('2026-08-14T06:05:00Z'),
      }),
    ).toEqual({ windowStartIso: '2026-08-14T06:00:00Z', decidedAtIso: '2026-08-14T06:05:00Z' });
  });
});
