import { describe, expect, it } from 'vitest';

import {
  ALERT_EVALUATION_SQL,
  alertEvaluationTransactionOver,
  createPgAlertEvaluationStore,
  evaluatedArrays,
  type PgAlertEvaluationClient,
} from './pg-alert-evaluation-store.js';
import { decodeEvaluationEventRow } from './pg-alertable-events.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubClient extends PgAlertEvaluationClient {
  readonly queries: RecordedQuery[];
  released: number;
}

type Responder = (text: string) => { rows: Record<string, unknown>[]; rowCount: number | null };

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

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fire_event_id: '9007199254740993',
    seq: '41',
    public_id: 'fw-2026-a1b2c',
    status: 'active',
    score: 0,
    invalidated: false,
    relation_kind: null,
    started_at: new Date('2026-08-14T11:00:00Z'),
    last_detection_at: new Date('2026-08-14T11:55:00Z'),
    lat: 42.6,
    lon: 23.3,
    merged: false,
    superseded: false,
    member_count: 3,
    persistent_count: 2,
    night_high_count: 1,
    non_geo_count: 2,
    latest_quarantined: false,
    status_before: null,
    ...overrides,
  };
}

describe('the statements', () => {
  it('fences every identity writer with FOR SHARE on the run rows', () => {
    expect(ALERT_EVALUATION_SQL.fence).toBe('SELECT id FROM clustering_runs ORDER BY id FOR SHARE');
  });

  it('pages events strictly after the cursor in seq order', () => {
    expect(ALERT_EVALUATION_SQL.selectEventsAfter).toContain('WHERE e.seq > $1::bigint');
    expect(ALERT_EVALUATION_SQL.selectEventsAfter).toMatch(/ORDER BY e\.seq\s+LIMIT \$2::int$/);
  });

  it('never moves the cursor or a mark backwards', () => {
    expect(ALERT_EVALUATION_SQL.advanceCursor).toContain(
      'WHERE alert_evaluation_cursor.last_seq <= EXCLUDED.last_seq',
    );
    expect(ALERT_EVALUATION_SQL.upsertEvaluated).toContain(
      'WHERE alert_evaluated_events.last_seq <= EXCLUDED.last_seq',
    );
  });

  it('counts only live-run members and keeps quarantined ones out of persistence', () => {
    const text = ALERT_EVALUATION_SQL.selectEventsAfter;
    expect(text).toContain("r.kind = 'live'");
    expect(text).toContain('FILTER (WHERE NOT d.quarantined)');
    expect(text).toContain('ORDER BY ed.attached_at DESC, ed.detection_uid DESC');
  });
});

describe('the transaction', () => {
  it('begins, fences, runs the work, commits and releases', async () => {
    const client = stubClient();
    const store = createPgAlertEvaluationStore({ connect: () => Promise.resolve(client) });

    expect(await store.withTransaction(() => Promise.resolve('done'))).toBe('done');
    expect(client.queries.map((q) => q.text)).toEqual([
      'BEGIN',
      ALERT_EVALUATION_SQL.fence,
      'COMMIT',
    ]);
    expect(client.released).toBe(1);
  });

  it('rolls back, surfaces the original error and still releases', async () => {
    const client = stubClient((text) => {
      if (text === 'ROLLBACK') throw new Error('rollback failed too');
      return { rows: [], rowCount: 0 };
    });
    const store = createPgAlertEvaluationStore({ connect: () => Promise.resolve(client) });

    await expect(store.withTransaction(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(client.queries.map((q) => q.text)).toContain('ROLLBACK');
    expect(client.queries.map((q) => q.text)).not.toContain('COMMIT');
    expect(client.released).toBe(1);
  });
});

describe('the cursor', () => {
  it('reads 0 before the first batch', async () => {
    const tx = alertEvaluationTransactionOver(stubClient());
    expect(await tx.readCursor()).toBe('0');
  });

  it('reads the stored seq as decimal text', async () => {
    const tx = alertEvaluationTransactionOver(
      stubClient(() => ({ rows: [{ last_seq: '9007199254740993' }], rowCount: 1 })),
    );
    expect(await tx.readCursor()).toBe('9007199254740993');
  });

  it('throws when the guarded advance touched no row', async () => {
    const tx = alertEvaluationTransactionOver(stubClient(() => ({ rows: [], rowCount: 0 })));
    await expect(tx.advanceCursor('7', '2026-08-14T12:00:00.000Z')).rejects.toThrow(/back/);
  });

  it('advances with the seq and the instant as bound values', async () => {
    const client = stubClient(() => ({ rows: [], rowCount: 1 }));
    await alertEvaluationTransactionOver(client).advanceCursor('42', '2026-08-14T12:00:00.000Z');
    expect(client.queries[0]?.values).toEqual(['42', '2026-08-14T12:00:00.000Z']);
  });
});

describe('the marks', () => {
  it('bind as parallel arrays', () => {
    expect(
      evaluatedArrays(
        [
          { fireEventId: '1', seq: '10', status: 'active' },
          { fireEventId: '2', seq: '11', status: 'signal_weakening' },
        ],
        '2026-08-14T12:00:00.000Z',
      ),
    ).toEqual([
      ['1', '2'],
      ['active', 'signal_weakening'],
      ['10', '11'],
      '2026-08-14T12:00:00.000Z',
    ]);
  });

  it('issue no statement for an empty batch', async () => {
    const client = stubClient();
    await alertEvaluationTransactionOver(client).recordEvaluated([], '2026-08-14T12:00:00.000Z');
    expect(client.queries).toEqual([]);
  });
});

describe('readEventsAfter', () => {
  it('rejects a non-positive limit before querying', async () => {
    const client = stubClient();
    await expect(alertEvaluationTransactionOver(client).readEventsAfter('0', 0)).rejects.toThrow(
      RangeError,
    );
    expect(client.queries).toEqual([]);
  });

  it('decodes the rows it reads', async () => {
    const client = stubClient(() => ({ rows: [eventRow()], rowCount: 1 }));
    const [row] = await alertEvaluationTransactionOver(client).readEventsAfter('40', 100);
    expect(client.queries[0]?.values).toEqual(['40', 100]);
    expect(row?.seq).toBe('41');
    expect(row?.event.detectionCount).toBe(2);
  });
});

describe('decodeEvaluationEventRow', () => {
  it('aggregates persistence over unquarantined members only', () => {
    const row = decodeEvaluationEventRow(eventRow());
    expect(row).toMatchObject({
      fireEventId: '9007199254740993',
      seq: '41',
      centroid: { lat: 42.6, lon: 23.3 },
      merged: false,
      superseded: false,
      memberCount: 3,
    });
    expect(row.event).toEqual({
      publicId: 'fw-2026-a1b2c',
      score: 0,
      detectionCount: 2,
      nightHighConfidenceCount: 1,
      geoOnly: false,
      invalidated: false,
      quarantined: false,
      status: 'active',
      statusBefore: null,
      relationKind: null,
      burnedAreaHa: null,
      startedAt: Date.parse('2026-08-14T11:00:00Z'),
      lastDetectionAt: Date.parse('2026-08-14T11:55:00Z'),
    });
  });

  it('is GEO-only only when some unquarantined member exists and none is non-GEO', () => {
    expect(decodeEvaluationEventRow(eventRow({ non_geo_count: 0 })).event.geoOnly).toBe(true);
    expect(
      decodeEvaluationEventRow(eventRow({ persistent_count: 0, non_geo_count: 0 })).event.geoOnly,
    ).toBe(false);
  });

  it('carries the last evaluated status and the latest member’s quarantine', () => {
    const row = decodeEvaluationEventRow(
      eventRow({ status_before: 'signal_weakening', latest_quarantined: true }),
    );
    expect(row.event.statusBefore).toBe('signal_weakening');
    expect(row.event.quarantined).toBe(true);
  });

  it('rejects unexpected shapes', () => {
    expect(() => decodeEvaluationEventRow(eventRow({ status: 'burning' }))).toThrow(/status/);
    expect(() => decodeEvaluationEventRow(eventRow({ status_before: 'x' }))).toThrow(
      /status_before/,
    );
    expect(() => decodeEvaluationEventRow(eventRow({ relation_kind: 'merge' }))).toThrow(
      /relation_kind/,
    );
    expect(() => decodeEvaluationEventRow(eventRow({ seq: '-1' }))).toThrow(/seq/);
    expect(() => decodeEvaluationEventRow(eventRow({ member_count: 1.5 }))).toThrow(/member_count/);
  });
});
