import { describe, expect, it } from 'vitest';

import {
  createPgShadowDiffReader,
  decodeSideAlert,
  decodeSideEvent,
  SHADOW_DIFF_READER_SQL,
  type PgShadowDiffQueryable,
} from './pg-shadow-diff-reader.js';

const ZONE = '11111111-0000-4000-8000-000000000001';
const FROM = Date.parse('2026-08-20T00:00:00Z');
const TO = Date.parse('2026-08-21T00:00:00Z');
const WINDOW = { fromMs: FROM, toMs: TO };

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgShadowDiffQueryable {
  readonly queries: RecordedQuery[];
}

/** Answers each query with the next scripted row set, in call order. */
function stubDb(...results: readonly (readonly Record<string, unknown>[])[]): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const rows = results[queries.length] ?? [];
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    },
  };
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_key: 'fw-2026-q7f3d',
    status: 'active',
    score: 0.8199999928474426,
    started_at: new Date('2026-08-20T02:00:00Z'),
    last_detection_at: new Date('2026-08-20T11:00:00Z'),
    invalidated: false,
    merged_into: null,
    detection_uids: ['a', 'b'],
    ...overrides,
  };
}

function alertRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: ZONE,
    event_key: 'fw-2026-q7f3d',
    alert_type: 'new_fire',
    alert_subkey: 'new_fire',
    template_id: 'new_fire_v1',
    decided_at: new Date('2026-08-20T11:29:30Z'),
    ...overrides,
  };
}

describe('the statements', () => {
  it('reads the live side through public ids and translates the merge survivor', () => {
    expect(SHADOW_DIFF_READER_SQL.selectLiveEvents).toContain('e.public_id AS event_key');
    expect(SHADOW_DIFF_READER_SQL.selectLiveEvents).toContain('m.public_id AS merged_into');
  });

  it('takes live membership only from live and promoted runs', () => {
    expect(SHADOW_DIFF_READER_SQL.selectLiveEvents).toContain(
      "(r.kind = 'live' OR r.promoted_at IS NOT NULL)",
    );
  });

  it('pulls in events named by an in-window alert, once', () => {
    for (const sql of [
      SHADOW_DIFF_READER_SQL.selectLiveEvents,
      SHADOW_DIFF_READER_SQL.selectShadowEvents,
    ]) {
      expect(sql).toContain('UNION\n');
      expect(sql).not.toContain('UNION ALL');
      expect(sql).toContain('last_detection_at >= $');
    }
  });

  it('never reads a live manual alert', () => {
    expect(SHADOW_DIFF_READER_SQL.selectLiveAlerts).toContain("trigger_type <> 'manual'");
    expect(SHADOW_DIFF_READER_SQL.selectLiveEvents).toContain("trigger_type <> 'manual'");
  });

  it('scopes every shadow read to the candidate', () => {
    for (const sql of [
      SHADOW_DIFF_READER_SQL.selectShadowEvents,
      SHADOW_DIFF_READER_SQL.selectShadowAlerts,
      SHADOW_DIFF_READER_SQL.selectZoneShadowAlerts,
    ]) {
      expect(sql).toContain('candidate_version = $1');
    }
  });

  it('never touches the live tables from the zone hook', () => {
    expect(SHADOW_DIFF_READER_SQL.selectZoneShadowAlerts).toContain('a.watch_zone_id = $4::uuid');
    expect(SHADOW_DIFF_READER_SQL.selectZoneShadowAlerts).not.toMatch(/alert_outbox|fire_events/);
  });
});

describe('loadWindow', () => {
  it('binds the half-open window as ISO instants and decodes both sides', async () => {
    const db = stubDb(
      [eventRow()],
      [alertRow()],
      [eventRow({ event_key: 's-1', detection_uids: ['a'] })],
      [alertRow({ event_key: 's-1' })],
    );
    const sides = await createPgShadowDiffReader(db).loadWindow({
      candidateVersion: 'clustering_v2',
      window: WINDOW,
    });

    expect(db.queries.map((q) => q.values)).toEqual([
      ['2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'],
      ['2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'],
      ['clustering_v2', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'],
      ['clustering_v2', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'],
    ]);
    expect(sides.live.events).toEqual([
      {
        key: 'fw-2026-q7f3d',
        status: 'active',
        score: 0.8199999928474426,
        startedAtMs: Date.parse('2026-08-20T02:00:00Z'),
        lastDetectionAtMs: Date.parse('2026-08-20T11:00:00Z'),
        invalidated: false,
        mergedInto: null,
        detectionUids: ['a', 'b'],
      },
    ]);
    expect(sides.shadow.events[0]?.key).toBe('s-1');
    expect(sides.live.alerts).toEqual([
      {
        zoneId: ZONE,
        eventKey: 'fw-2026-q7f3d',
        alertType: 'new_fire',
        alertSubkey: 'new_fire',
        templateId: 'new_fire_v1',
        decidedAtMs: Date.parse('2026-08-20T11:29:30Z'),
      },
    ]);
    expect(sides.shadow.alerts[0]?.eventKey).toBe('s-1');
  });

  it('refuses an empty window before asking the database', async () => {
    const db = stubDb();
    await expect(
      createPgShadowDiffReader(db).loadWindow({
        candidateVersion: 'clustering_v2',
        window: { fromMs: TO, toMs: TO },
      }),
    ).rejects.toThrow(/end after it starts/);
    expect(db.queries).toEqual([]);
  });
});

describe('shadowAlertsForZone', () => {
  it('binds the zone as its own parameter', async () => {
    const db = stubDb([alertRow({ event_key: 's-1' })]);
    const alerts = await createPgShadowDiffReader(db).shadowAlertsForZone({
      zoneId: ZONE,
      candidateVersion: 'clustering_v2',
      window: WINDOW,
    });

    expect(db.queries).toEqual([
      {
        text: SHADOW_DIFF_READER_SQL.selectZoneShadowAlerts,
        values: ['clustering_v2', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z', ZONE],
      },
    ]);
    expect(alerts.map((a) => a.eventKey)).toEqual(['s-1']);
  });
});

describe('decoding', () => {
  it('keeps a merge survivor and an empty membership', () => {
    expect(
      decodeSideEvent(eventRow({ merged_into: 'fw-2026-b2k9m', detection_uids: [] })),
    ).toMatchObject({ mergedInto: 'fw-2026-b2k9m', detectionUids: [] });
  });

  it.each([
    [{ status: 'out' }, /status/],
    [{ score: '0.8' }, /score/],
    [{ started_at: '2026-08-20T02:00:00Z' }, /started_at/],
    [{ invalidated: 'f' }, /invalidated/],
    [{ merged_into: 7 }, /merged_into/],
    [{ detection_uids: 'a,b' }, /detection_uids/],
    [{ detection_uids: ['a', 1] }, /detection_uids/],
  ])('refuses an event row with %j', (overrides, message) => {
    expect(() => decodeSideEvent(eventRow(overrides))).toThrow(message);
  });

  it.each([
    [{ alert_type: 'all_clear' }, /alert_type/],
    [{ zone_id: null }, /zone_id/],
    [{ decided_at: 0 }, /decided_at/],
  ])('refuses an alert row with %j', (overrides, message) => {
    expect(() => decodeSideAlert(alertRow(overrides))).toThrow(message);
  });

  it('names the column, not the value, for an unknown alert type', () => {
    expect(() => decodeSideAlert(alertRow({ alert_type: 'all_clear' }))).not.toThrow(/all_clear/);
  });
});
