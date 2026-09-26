import { describe, expect, it } from 'vitest';

import type { DecisionLogEntry } from '../../core/ports/alert-decision-log.js';
import {
  ALERT_DECISION_LOG_SQL,
  createPgAlertDecisionLog,
  decisionLogArrays,
  decodeDecisionLogRow,
  type PgDecisionLogQueryable,
} from './pg-alert-decision-log.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function stubDb(
  respond: () => { rows: Record<string, unknown>[]; rowCount: number | null } = () => ({
    rows: [],
    rowCount: 0,
  }),
): PgDecisionLogQueryable & { readonly queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve(respond() as { rows: Row[]; rowCount: number | null });
    },
  };
}

const ZONE = '11111111-1111-4111-8111-111111111111';

function entry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    zoneId: ZONE,
    fireEventId: '9007199254740993',
    triggerRefSeq: '41',
    pass: 'evaluation',
    outcome: 'suppress',
    reason: 'below_zone_threshold',
    code: 'suppressed_below_zone_threshold',
    alertType: null,
    ladderStep: 0,
    inQuietHours: false,
    ruleVersion: 'alert_gating_v1',
    decidedAtIso: '2026-08-14T12:00:00Z',
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    watch_zone_id: ZONE,
    fire_event_id: '9007199254740993',
    trigger_ref_seq: '41',
    pass: 'evaluation',
    outcome: 'send',
    reason: 'first_alert',
    code: 'sent_first_alert',
    alert_type: 'new_fire',
    ladder_step: 1,
    in_quiet_hours: false,
    rule_version: 'alert_gating_v1',
    decided_at: new Date('2026-08-14T12:00:00Z'),
    ...overrides,
  };
}

describe('ALERT_DECISION_LOG_SQL', () => {
  it('appends idempotently on the once-per-trigger key and never updates', () => {
    expect(ALERT_DECISION_LOG_SQL.append).toMatch(/^INSERT INTO alert_decision_log/);
    expect(ALERT_DECISION_LOG_SQL.append).toContain(
      'ON CONFLICT ON CONSTRAINT alert_decision_log_once_per_trigger DO NOTHING',
    );
    expect(ALERT_DECISION_LOG_SQL.append).not.toMatch(/\bUPDATE\b|\bDELETE\b/);
  });

  it('reads one pair, oldest first, with bigints as text', () => {
    const sql = ALERT_DECISION_LOG_SQL.selectForPair;
    expect(sql).toContain('WHERE watch_zone_id = $1::uuid AND fire_event_id = $2::bigint');
    expect(sql).toContain('ORDER BY decided_at, trigger_ref_seq, id');
    expect(sql).toContain('fire_event_id::text');
    expect(sql).toContain('trigger_ref_seq::text');
  });
});

describe('decisionLogArrays', () => {
  it('binds one array per column, in the statement order', () => {
    const typed = entry({
      outcome: 'send',
      reason: 'first_alert',
      code: 'sent_first_alert',
      alertType: 'new_fire',
      ladderStep: 1,
      inQuietHours: true,
      triggerRefSeq: '42',
    });
    expect(decisionLogArrays([entry(), typed])).toEqual([
      [ZONE, ZONE],
      ['9007199254740993', '9007199254740993'],
      ['41', '42'],
      ['evaluation', 'evaluation'],
      ['suppress', 'send'],
      ['below_zone_threshold', 'first_alert'],
      ['suppressed_below_zone_threshold', 'sent_first_alert'],
      [null, 'new_fire'],
      [0, 1],
      [false, true],
      ['alert_gating_v1', 'alert_gating_v1'],
      ['2026-08-14T12:00:00Z', '2026-08-14T12:00:00Z'],
    ]);
  });
});

describe('createPgAlertDecisionLog', () => {
  it('does not touch the database for an empty append', async () => {
    const db = stubDb();
    await expect(createPgAlertDecisionLog(db).append([])).resolves.toBe(0);
    expect(db.queries).toEqual([]);
  });

  it('resolves the inserted count, so a replayed entry counts zero', async () => {
    const db = stubDb(() => ({ rows: [], rowCount: 1 }));
    await expect(createPgAlertDecisionLog(db).append([entry(), entry()])).resolves.toBe(1);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(ALERT_DECISION_LOG_SQL.append);
  });

  it('treats a null rowCount as zero inserted', async () => {
    const db = stubDb(() => ({ rows: [], rowCount: null }));
    await expect(createPgAlertDecisionLog(db).append([entry()])).resolves.toBe(0);
  });

  it('loads a pair and decodes its rows', async () => {
    const db = stubDb(() => ({ rows: [row()], rowCount: 1 }));
    const loaded = await createPgAlertDecisionLog(db).loadForPair(ZONE, '9007199254740993');
    expect(db.queries[0]?.values).toEqual([ZONE, '9007199254740993']);
    expect(loaded).toEqual([
      entry({
        outcome: 'send',
        reason: 'first_alert',
        code: 'sent_first_alert',
        alertType: 'new_fire',
        ladderStep: 1,
      }),
    ]);
  });
});

describe('decodeDecisionLogRow', () => {
  it('keeps a null alert type null', () => {
    expect(decodeDecisionLogRow(row({ alert_type: null })).alertType).toBeNull();
  });

  it.each([
    ['pass', 'seed_pass'],
    ['outcome', 'ignore'],
    ['reason', 'because'],
    ['code', 'sent_whatever'],
    ['alert_type', 'digest'],
  ])('refuses an unknown %s', (column, value) => {
    expect(() => decodeDecisionLogRow(row({ [column]: value }))).toThrow(column);
  });

  it('refuses a decided_at that is not a timestamp', () => {
    expect(() => decodeDecisionLogRow(row({ decided_at: '2026-08-14' }))).toThrow(/decided_at/);
  });
});
