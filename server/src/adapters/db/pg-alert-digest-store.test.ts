import { describe, expect, it } from 'vitest';

import type { DigestLogEntry } from '../../core/ports/alert-digest-store.js';
import {
  ALERT_DIGEST_SQL,
  alertDigestTransactionOver,
  createPgAlertDigestStore,
  decodePairRow,
  digestLogArrays,
  type PgAlertDigestClient,
  type PgAlertDigestPool,
} from './pg-alert-digest-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Responder = (text: string) => { rows: Record<string, unknown>[]; rowCount: number | null };

interface StubClient extends PgAlertDigestClient {
  readonly queries: RecordedQuery[];
  released: number;
}

function stubClient(respond: Responder = () => ({ rows: [], rowCount: 0 })): StubClient {
  const queries: RecordedQuery[] = [];
  const client: StubClient = {
    queries,
    released: 0,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      try {
        return Promise.resolve(respond(text) as { rows: Row[]; rowCount: number | null });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    release() {
      client.released += 1;
    },
  };
  return client;
}

function stubPool(client: StubClient): PgAlertDigestPool {
  return {
    connect: () => Promise.resolve(client),
    query: (text, values) => client.query(text, values),
  };
}

function pairRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: '6f1c2d4e-0000-4000-8000-000000000001',
    fire_event_id: '9007199254740993',
    seq: '41',
    public_id: 'fw-2026-a1b2c',
    lat: 42.6,
    lon: 23.3,
    seeded_at: null,
    last_notified_at: new Date('2026-08-14T11:00:00Z'),
    last_deferred_at: new Date('2026-08-14T12:30:00.250Z'),
    ...overrides,
  };
}

const ENTRY: DigestLogEntry = {
  zoneId: '6f1c2d4e-0000-4000-8000-000000000001',
  windowStartIso: '2026-08-14T06:00:00Z',
  outcome: 'send',
  reason: 'daily_summary',
  entryCount: 2,
  ruleVersion: 'digest_params_v1',
  decidedAtIso: '2026-08-14T06:05:00Z',
};

describe('the statements', () => {
  it('lists only live accounts with a live sealed zone, strictly after the page key', () => {
    const text = ALERT_DIGEST_SQL.listAccountsAfter;
    expect(text).toContain('a.deleted_at IS NULL');
    expect(text).toContain('($1::uuid IS NULL OR a.id > $1::uuid)');
    expect(text).toContain('z.deleted_at IS NULL AND z.centre_ciphertext IS NOT NULL');
    expect(text).toMatch(/ORDER BY a\.id\s+LIMIT \$2::int$/);
  });

  it('holds the account row against erasure, and only while it is not tombstoned', () => {
    expect(ALERT_DIGEST_SQL.lockAccount).toMatch(
      /WHERE id = \$1::uuid AND deleted_at IS NULL\s+FOR SHARE$/,
    );
  });

  it('derives the watermark from spent windows over every zone, deleted ones included', () => {
    const text = ALERT_DIGEST_SQL.selectWatermark;
    expect(text).toContain("l.outcome IN ('send', 'suppress')");
    expect(text).not.toContain('deleted_at');
    expect(text).toContain('min(l.decided_at)');
    expect(text).toMatch(/ORDER BY l\.window_start DESC\s+LIMIT 1$/);
  });

  it('reads only digestible pairs the zone has been told about', () => {
    const text = ALERT_DIGEST_SQL.selectPairs;
    for (const clause of [
      "s.state <> 'none'",
      'e.merged_into IS NULL',
      'NOT e.invalidated',
      "e.status IN ('active', 'signal_weakening')",
      'NOT EXISTS (SELECT 1 FROM fire_events c WHERE c.related_event_id = e.id)',
      'z.deleted_at IS NULL',
      'z.centre_ciphertext IS NOT NULL',
      "l.pass = 'evaluation'",
      "l.outcome = 'defer'",
    ]) {
      expect(text).toContain(clause);
    }
  });

  it('appends idempotently under migration 018 unique key', () => {
    expect(ALERT_DIGEST_SQL.appendLog).toMatch(
      /ON CONFLICT ON CONSTRAINT alert_digest_log_once_per_window DO NOTHING$/,
    );
  });

  it('binds the log columns in statement order', () => {
    expect(digestLogArrays([ENTRY])).toEqual([
      [ENTRY.zoneId],
      [ENTRY.windowStartIso],
      ['send'],
      ['daily_summary'],
      [2],
      ['digest_params_v1'],
      [ENTRY.decidedAtIso],
    ]);
  });
});

describe('decodePairRow', () => {
  it('decodes ids as decimal text and timestamps as canonical ISO', () => {
    expect(decodePairRow(pairRow())).toEqual({
      zoneId: '6f1c2d4e-0000-4000-8000-000000000001',
      fireEventId: '9007199254740993',
      seq: '41',
      eventPublicId: 'fw-2026-a1b2c',
      centroid: { lat: 42.6, lon: 23.3 },
      seededAtIso: null,
      lastNotifiedAtIso: '2026-08-14T11:00:00Z',
      lastDeferredAtIso: '2026-08-14T12:30:00.250Z',
    });
  });

  it('refuses an unexpected shape rather than guessing', () => {
    expect(() => decodePairRow(pairRow({ seq: 41 }))).toThrow(/seq/);
    expect(() => decodePairRow(pairRow({ fire_event_id: '-1' }))).toThrow(/fire_event_id/);
    expect(() => decodePairRow(pairRow({ lat: null }))).toThrow(/lat/);
    expect(() => decodePairRow(pairRow({ seeded_at: '2026-08-14' }))).toThrow(/seeded_at/);
  });
});

describe('the transaction', () => {
  it('returns null settings for a tombstoned account and decodes a live one', async () => {
    const empty = alertDigestTransactionOver(stubClient());
    expect(await empty.lockAccount('a')).toBeNull();

    const live = alertDigestTransactionOver(
      stubClient(() => ({
        rows: [
          {
            timezone: 'Europe/Sofia',
            quiet_hours_start: '22:00',
            quiet_hours_end: '07:00',
            new_fire_overrides_quiet_hours: true,
          },
        ],
        rowCount: 1,
      })),
    );
    expect(await live.lockAccount('a')).toEqual({
      timezone: 'Europe/Sofia',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      newFireOverridesQuietHours: true,
    });
  });

  it('reads the watermark as canonical ISO, or null for none', async () => {
    const none = alertDigestTransactionOver(stubClient());
    expect(await none.readWatermark('a')).toBeNull();

    const some = alertDigestTransactionOver(
      stubClient(() => ({
        rows: [
          {
            window_start: new Date('2026-08-14T06:00:00Z'),
            decided_at: new Date('2026-08-14T07:05:00Z'),
          },
        ],
        rowCount: 1,
      })),
    );
    expect(await some.readWatermark('a')).toEqual({
      windowStartIso: '2026-08-14T06:00:00Z',
      decidedAtIso: '2026-08-14T07:05:00Z',
    });
  });

  it('reports how many log rows were new, and sends nothing for an empty append', async () => {
    const client = stubClient(() => ({ rows: [], rowCount: 1 }));
    const tx = alertDigestTransactionOver(client);

    expect(await tx.appendLog([])).toBe(0);
    expect(client.queries).toEqual([]);
    expect(await tx.appendLog([ENTRY, { ...ENTRY, zoneId: 'other' }])).toBe(1);
    expect(client.queries[0]?.text).toBe(ALERT_DIGEST_SQL.appendLog);
  });
});

describe('createPgAlertDigestStore', () => {
  it('commits a unit of work that resolves, and releases the client', async () => {
    const client = stubClient();
    const store = createPgAlertDigestStore(stubPool(client));

    await expect(store.withAccount('a', () => Promise.resolve(7))).resolves.toBe(7);

    expect(client.queries.map((q) => q.text)).toEqual(['BEGIN', 'COMMIT']);
    expect(client.released).toBe(1);
  });

  it('rolls back a unit of work that throws, surfaces its error, and releases the client', async () => {
    const client = stubClient((text) => {
      if (text === 'ROLLBACK') throw new Error('rollback failed too');
      return { rows: [], rowCount: 0 };
    });
    const store = createPgAlertDigestStore(stubPool(client));

    await expect(store.withAccount('a', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    expect(client.queries.map((q) => q.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.released).toBe(1);
  });

  it('pages accounts through the pool and refuses a bad limit', async () => {
    const client = stubClient(() => ({ rows: [{ id: 'b' }, { id: 'c' }], rowCount: 2 }));
    const store = createPgAlertDigestStore(stubPool(client));

    expect(await store.listAccountsAfter('a', 2)).toEqual(['b', 'c']);
    expect(client.queries[0]?.values).toEqual(['a', 2]);
    await expect(store.listAccountsAfter(null, 0)).rejects.toThrow(RangeError);
  });
});
