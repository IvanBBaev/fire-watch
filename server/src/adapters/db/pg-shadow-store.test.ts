import { describe, expect, it } from 'vitest';

import type { ShadowAlertRow } from '../../core/ports/shadow-store.js';
import type { ShadowSideEvent } from '../../core/shadow/shadow-diff.js';
import {
  alertArrays,
  createPgShadowStore,
  eventArrays,
  SHADOW_STORE_SQL,
  type PgShadowStoreQueryable,
} from './pg-shadow-store.js';

const ZONE = '11111111-0000-4000-8000-000000000001';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgShadowStoreQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(rowCount: number | null = 0): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rowCount });
    },
  };
}

function event(overrides: Partial<ShadowSideEvent> = {}): ShadowSideEvent {
  return {
    key: 's-1',
    status: 'active',
    score: 0.82,
    startedAtMs: Date.parse('2026-08-20T02:00:00Z'),
    lastDetectionAtMs: Date.parse('2026-08-20T11:00:00Z'),
    invalidated: false,
    mergedInto: null,
    detectionUids: ['b', 'a'],
    ...overrides,
  };
}

function alert(overrides: Partial<ShadowAlertRow> = {}): ShadowAlertRow {
  return {
    zoneId: ZONE,
    eventKey: 's-1',
    alertType: 'new_fire',
    alertSubkey: 'new_fire',
    templateId: 'new_fire_v1',
    decidedAtMs: Date.parse('2026-08-20T11:29:30Z'),
    ruleVersion: 'alert_gating_v1',
    templateParams: { distance_km: 4 },
    ...overrides,
  };
}

const EVENTS = {
  candidateVersion: 'clustering_v2',
  candidateConfigDigest: 'd1',
  events: [event()],
};

describe('the statements', () => {
  it('binds arrays, not one parameter per row', () => {
    expect(SHADOW_STORE_SQL.upsertEvents).toContain('FROM unnest($3::text[]');
    expect(SHADOW_STORE_SQL.insertAlerts).toContain('FROM unnest($2::uuid[]');
  });

  it('rebuilds each detection set in the order it was bound', () => {
    expect(SHADOW_STORE_SQL.upsertEvents).toContain('WITH ORDINALITY');
    expect(SHADOW_STORE_SQL.upsertEvents).toContain('ORDER BY uid.n');
  });

  it('replaces whole event rows but keeps the first sighting', () => {
    expect(SHADOW_STORE_SQL.upsertEvents).toContain('detection_uids = EXCLUDED.detection_uids');
    expect(SHADOW_STORE_SQL.upsertEvents).toContain('updated_at = EXCLUDED.updated_at');
    expect(SHADOW_STORE_SQL.upsertEvents).not.toContain('recorded_at');
  });

  it('never updates an alert and stamps the trigger as the alert type', () => {
    expect(SHADOW_STORE_SQL.insertAlerts).toContain('ON CONFLICT DO NOTHING');
    expect(SHADOW_STORE_SQL.insertAlerts).not.toContain('DO UPDATE');
    expect(SHADOW_STORE_SQL.insertAlerts).toContain('b.alert_subkey, b.alert_type');
  });

  it('writes only the shadow tables', () => {
    for (const sql of Object.values(SHADOW_STORE_SQL)) {
      expect(sql).not.toMatch(/fire_events|alert_outbox|alert_states|event_detections/);
    }
  });
});

describe('upsertEvents', () => {
  it('sends one statement and reports the count', async () => {
    const db = stubDb(1);
    expect(await createPgShadowStore(db).upsertEvents(EVENTS)).toBe(1);
    expect(db.queries.map((q) => q.text)).toEqual([SHADOW_STORE_SQL.upsertEvents]);
  });

  it('skips the round trip for an empty batch', async () => {
    const db = stubDb();
    expect(await createPgShadowStore(db).upsertEvents({ ...EVENTS, events: [] })).toBe(0);
    expect(db.queries).toEqual([]);
  });

  it('binds sorted detection sets as JSON and instants as ISO', () => {
    expect(eventArrays(EVENTS)).toEqual([
      'clustering_v2',
      'd1',
      ['s-1'],
      ['active'],
      ['2026-08-20T02:00:00.000Z'],
      ['2026-08-20T11:00:00.000Z'],
      [0.82],
      [false],
      [null],
      ['["a","b"]'],
    ]);
  });

  it('sorts by code unit, not by locale', () => {
    const values = eventArrays({ ...EVENTS, events: [event({ detectionUids: ['b', 'B', 'a'] })] });
    expect(values[9]).toEqual(['["B","a","b"]']);
  });

  it.each([
    [[event(), event()], /names event "s-1" twice/],
    [[event({ detectionUids: ['a', 'a'] })], /lists a detection twice/],
  ])('refuses a malformed batch before the query', async (events, message) => {
    const db = stubDb();
    await expect(createPgShadowStore(db).upsertEvents({ ...EVENTS, events })).rejects.toThrow(
      message,
    );
    expect(db.queries).toEqual([]);
  });
});

describe('recordAlerts', () => {
  it('reports only the rows newly inserted', async () => {
    const db = stubDb(0);
    expect(
      await createPgShadowStore(db).recordAlerts({
        candidateVersion: 'clustering_v2',
        alerts: [alert()],
      }),
    ).toBe(0);
    expect(db.queries).toHaveLength(1);
  });

  it('skips the round trip for an empty batch', async () => {
    const db = stubDb();
    expect(
      await createPgShadowStore(db).recordAlerts({ candidateVersion: 'clustering_v2', alerts: [] }),
    ).toBe(0);
    expect(db.queries).toEqual([]);
  });

  it('binds template params as JSON text', () => {
    expect(alertArrays({ candidateVersion: 'clustering_v2', alerts: [alert()] })).toEqual([
      'clustering_v2',
      [ZONE],
      ['s-1'],
      ['new_fire'],
      ['new_fire'],
      ['alert_gating_v1'],
      ['new_fire_v1'],
      ['{"distance_km":4}'],
      ['2026-08-20T11:29:30.000Z'],
    ]);
  });
});
