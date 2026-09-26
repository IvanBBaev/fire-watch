import { describe, expect, it } from 'vitest';

import type { AlertStateRow } from '../../core/registry/alert-state.js';
import {
  ALERT_STATE_SQL,
  createPgAlertStateStore,
  upsertArrays,
  type PgAlertStateQueryable,
} from './pg-alert-state-store.js';

const ZONE = '11111111-0000-4000-8000-000000000001';
const OTHER_ZONE = '11111111-0000-4000-8000-000000000002';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgAlertStateQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(
  rows: readonly Record<string, unknown>[] = [],
  rowCount: number | null = 0,
): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount });
    },
  };
}

function row(overrides: Partial<AlertStateRow> = {}): AlertStateRow {
  return {
    zoneId: ZONE,
    eventPublicId: 'fw-2026-q7f3d',
    state: 'notified_new',
    escalationWatermark: 0,
    seededAtIso: null,
    lastNotifiedAtIso: '2026-08-02T11:29:30.000Z',
    ...overrides,
  };
}

describe('the statements', () => {
  it('makes an unknown event id fail the write instead of dropping one pair', () => {
    // The LEFT JOIN is the whole mechanism: an unmatched public id yields a NULL
    // `fire_event_id`, the column is NOT NULL, and the statement dies whole.
    expect(ALERT_STATE_SQL.upsertStates).toContain('LEFT JOIN fire_events e');
    expect(ALERT_STATE_SQL.upsertStates).not.toContain('\nJOIN fire_events');
  });

  it('writes whole rows, so a replayed decision reproduces the row it describes', () => {
    for (const column of [
      'state = EXCLUDED.state',
      'escalation_watermark = EXCLUDED.escalation_watermark',
      'seeded_at = EXCLUDED.seeded_at',
      'last_notified_at = EXCLUDED.last_notified_at',
    ]) {
      expect(ALERT_STATE_SQL.upsertStates).toContain(column);
    }
  });

  it('moves updated_at on the conflict path, which the column default cannot', () => {
    expect(ALERT_STATE_SQL.upsertStates).toContain('updated_at = EXCLUDED.updated_at');
  });

  it('takes the cross-event suppression instant from this table and nowhere else', () => {
    expect(ALERT_STATE_SQL.selectZoneLastNotified).toContain('max(last_notified_at)');
    expect(ALERT_STATE_SQL.selectZoneLastNotified).toContain('FROM alert_states');
    expect(ALERT_STATE_SQL.selectZoneLastNotified).not.toContain('watch_zones');
  });

  it('binds arrays rather than one parameter per row', () => {
    for (const sql of Object.values(ALERT_STATE_SQL)) {
      expect(sql).not.toContain('$7');
    }
  });
});

describe('reads', () => {
  it('asks nothing of the database for an empty batch', async () => {
    const db = stubDb();
    const store = createPgAlertStateStore(db);

    expect(await store.loadStates([])).toEqual([]);
    expect(await store.loadStatesForEvents([])).toEqual([]);
    expect(await store.lastNotifiedByZone([])).toEqual(new Map());
    expect(db.queries).toHaveLength(0);
  });

  it('sends one array per key column, positionally paired', async () => {
    const db = stubDb();
    await createPgAlertStateStore(db).loadStates([
      { zoneId: ZONE, eventPublicId: 'fw-2026-q7f3d' },
      { zoneId: OTHER_ZONE, eventPublicId: 'fw-2026-b2k9m' },
    ]);

    expect(db.queries[0]?.values).toEqual([
      [ZONE, OTHER_ZONE],
      ['fw-2026-q7f3d', 'fw-2026-b2k9m'],
    ]);
  });

  it('hands back the public id and the timestamps as ISO instants', async () => {
    const db = stubDb([
      {
        watch_zone_id: ZONE,
        public_id: 'fw-2026-q7f3d',
        state: 'notified_escalation',
        escalation_watermark: 2,
        seeded_at: new Date('2026-08-01T06:00:00Z'),
        last_notified_at: new Date('2026-08-02T11:29:30Z'),
      },
    ]);

    expect(
      await createPgAlertStateStore(db).loadStates([{ zoneId: ZONE, eventPublicId: 'x' }]),
    ).toEqual([
      {
        zoneId: ZONE,
        eventPublicId: 'fw-2026-q7f3d',
        state: 'notified_escalation',
        escalationWatermark: 2,
        seededAtIso: '2026-08-01T06:00:00.000Z',
        lastNotifiedAtIso: '2026-08-02T11:29:30.000Z',
      },
    ]);
  });

  it('keeps a never-notified seed distinguishable from a notified pair', async () => {
    const db = stubDb([
      {
        watch_zone_id: ZONE,
        public_id: 'fw-2026-q7f3d',
        state: 'notified_new',
        escalation_watermark: 0,
        seeded_at: new Date('2026-08-01T06:00:00Z'),
        last_notified_at: null,
      },
    ]);

    const [loaded] = await createPgAlertStateStore(db).loadStatesForEvents(['fw-2026-q7f3d']);
    expect(loaded?.seededAtIso).toBe('2026-08-01T06:00:00.000Z');
    expect(loaded?.lastNotifiedAtIso).toBeNull();
  });

  it('refuses a state the ladder does not define rather than reading it as one', async () => {
    const db = stubDb([
      {
        watch_zone_id: ZONE,
        public_id: 'fw-2026-q7f3d',
        state: 'resolved',
        escalation_watermark: 0,
        seeded_at: null,
        last_notified_at: null,
      },
    ]);

    await expect(
      createPgAlertStateStore(db).loadStatesForEvents(['fw-2026-q7f3d']),
    ).rejects.toThrow(/not a state/);
  });

  it('leaves a zone that has never sent anything out of the map', async () => {
    const db = stubDb([
      { watch_zone_id: ZONE, last_notified_at: new Date('2026-08-02T11:29:30Z') },
    ]);

    const notified = await createPgAlertStateStore(db).lastNotifiedByZone([ZONE, OTHER_ZONE]);
    expect(notified.get(ZONE)).toBe('2026-08-02T11:29:30.000Z');
    expect(notified.has(OTHER_ZONE)).toBe(false);
  });
});

describe('writes', () => {
  it('does not touch the table for a poll that decided nothing', async () => {
    const db = stubDb();
    expect(await createPgAlertStateStore(db).upsert([])).toBe(0);
    expect(await createPgAlertStateStore(db).remove([])).toBe(0);
    expect(db.queries).toHaveLength(0);
  });

  it('sends one array per column, in the order the statement names them', () => {
    expect(
      upsertArrays([
        row({ state: 'notified_new', seededAtIso: '2026-08-01T06:00:00.000Z' }),
        row({
          eventPublicId: 'fw-2026-b2k9m',
          state: 'notified_escalation',
          escalationWatermark: 3,
        }),
      ]),
    ).toEqual([
      [ZONE, ZONE],
      ['fw-2026-q7f3d', 'fw-2026-b2k9m'],
      ['notified_new', 'notified_escalation'],
      [0, 3],
      ['2026-08-01T06:00:00.000Z', null],
      ['2026-08-02T11:29:30.000Z', '2026-08-02T11:29:30.000Z'],
    ]);
  });

  it('refuses two rows for one pair rather than letting the database pick a winner', async () => {
    const db = stubDb([], 2);
    await expect(
      createPgAlertStateStore(db).upsert([row(), row({ state: 'notified_escalation' })]),
    ).rejects.toThrow(/fold them before writing/);
    expect(db.queries).toHaveLength(0);
  });

  it('allows the same event under two zones, which is the ordinary case', async () => {
    const db = stubDb([], 2);
    expect(await createPgAlertStateStore(db).upsert([row(), row({ zoneId: OTHER_ZONE })])).toBe(2);
  });

  it('reports how many pairs a removal actually found, because absent keys are not an error', async () => {
    const db = stubDb([], 1);
    expect(
      await createPgAlertStateStore(db).remove([
        { zoneId: ZONE, eventPublicId: 'fw-2026-q7f3d' },
        { zoneId: ZONE, eventPublicId: 'fw-2026-gone1' },
      ]),
    ).toBe(1);
  });
});
