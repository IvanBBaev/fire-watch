import { describe, expect, it } from 'vitest';

import type { StoredWeeklyReport } from '../../core/ports/qa-report-store.js';
import {
  decodePopulationRow,
  decodeTransition,
  createPgQaReportStore,
  decodeDarAlert,
  decodePlbTrace,
  MAX_MERGE_DEPTH,
  QA_REPORT_SQL,
  saveParameters,
  type PgQaReportQueryable,
} from './pg-qa-report-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgQaReportQueryable {
  readonly queries: RecordedQuery[];
}

/** Answers each query with the next scripted result, in call order. */
function stubDb(
  ...results: readonly { rows?: readonly Record<string, unknown>[]; rowCount?: number }[]
): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const result = results[queries.length] ?? {};
      queries.push({ text, values });
      const rows = (result.rows ?? []) as Row[];
      return Promise.resolve({ rows, rowCount: result.rowCount ?? rows.length });
    },
  };
}

const WINDOW = {
  fromMs: Date.parse('2026-09-14T00:00:00Z'),
  toMs: Date.parse('2026-09-21T00:00:00Z'),
};

const REPORT: StoredWeeklyReport = {
  isoWeek: '2026-W38',
  fromMs: WINDOW.fromMs,
  toMs: WINDOW.toMs,
  metricsVersion: 'qa_metrics_v1',
  metricsDigest: '43e53e7c',
  reportVersion: 'qa_weekly_report_v1',
  reportDigest: '8cae3b34',
  generatedAtMs: Date.parse('2026-09-21T00:05:00Z'),
  reportJson: '{"kind":"fire_watch_qa_weekly_report"}',
  reportMarkdown: '# report\n',
};

describe('the SQL', () => {
  it('reads PLB traces by arrival, SP excluded, first attachment over live runs only', () => {
    const sql = QA_REPORT_SQL.selectPlbTraces;
    expect(sql).toContain('d.available_at >= $1::timestamptz AND d.available_at < $2::timestamptz');
    expect(sql).toContain("d.product_tier <> 'SP'");
    expect(sql).toContain("r.kind = 'live'");
    expect(sql).toContain('min(ed.attached_at)');
    expect(sql).toContain('ed.acq_ts = d.acq_ts');
    expect(sql).not.toContain('quarantined');
  });

  it('reads automatic alerts by decision, merge-resolved within a bounded chain', () => {
    const sql = QA_REPORT_SQL.selectDarAlerts;
    expect(sql).toContain('WITH RECURSIVE');
    expect(sql).toContain("o.trigger_type <> 'manual'");
    expect(sql).toContain('o.decided_at >= $1::timestamptz AND o.decided_at < $2::timestamptz');
    expect(sql).toContain(`c.depth < ${String(MAX_MERGE_DEPTH)}`);
    expect(sql).toContain('ORDER BY alert_id, depth DESC');
    expect(sql).not.toContain('status');
  });

  it('refuses a different digest under the same versions', () => {
    expect(QA_REPORT_SQL.upsertReport).toContain(
      'ON CONFLICT (iso_week, metrics_version, report_version) DO UPDATE',
    );
    expect(QA_REPORT_SQL.upsertReport).toContain(
      'WHERE r.metrics_digest = EXCLUDED.metrics_digest AND r.report_digest = EXCLUDED.report_digest',
    );
  });
});

describe('loadPlbTraces', () => {
  it('binds the window as ISO instants and decodes the rows', async () => {
    const db = stubDb({
      rows: [
        {
          detection_uid: 'a'.repeat(64),
          available_at: new Date('2026-09-14T01:00:00Z'),
          ingested_at: new Date('2026-09-14T01:01:00Z'),
          event_updated_at: new Date('2026-09-14T01:02:00Z'),
        },
        {
          detection_uid: 'b'.repeat(64),
          available_at: new Date('2026-09-14T02:00:00Z'),
          ingested_at: new Date('2026-09-14T02:01:00Z'),
          event_updated_at: null,
        },
      ],
    });
    const traces = await createPgQaReportStore(db).loadPlbTraces(WINDOW);
    expect(db.queries[0]?.text).toBe(QA_REPORT_SQL.selectPlbTraces);
    expect(db.queries[0]?.values).toEqual(['2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z']);
    expect(traces).toEqual([
      {
        traceId: 'a'.repeat(64),
        availableAtMs: Date.parse('2026-09-14T01:00:00Z'),
        ingestedAtMs: Date.parse('2026-09-14T01:01:00Z'),
        eventUpdatedAtMs: Date.parse('2026-09-14T01:02:00Z'),
        decidedAtMs: null,
        providerAckAtMs: null,
        providerChannel: null,
        broadcastAtMs: null,
      },
      expect.objectContaining({ traceId: 'b'.repeat(64), eventUpdatedAtMs: null }),
    ]);
  });

  it('refuses a row with no ingested_at', () => {
    expect(() =>
      decodePlbTrace({
        detection_uid: 'a',
        available_at: new Date(0),
        ingested_at: null,
        event_updated_at: null,
      }),
    ).toThrow();
  });
});

describe('loadDarAlerts', () => {
  const row = {
    alert_id: '42',
    zone_id: '00000000-0000-4000-8000-000000000001',
    event_key: 'evt-survivor',
    alert_type: 'escalation',
    alert_subkey: 'step-2',
    decided_at: new Date('2026-09-14T03:00:00Z'),
    resolved: true,
  };

  it('decodes the survivor key and the subkey', async () => {
    const db = stubDb({ rows: [row] });
    const alerts = await createPgQaReportStore(db).loadDarAlerts(WINDOW);
    expect(db.queries[0]?.text).toBe(QA_REPORT_SQL.selectDarAlerts);
    expect(alerts).toEqual([
      {
        alertId: '42',
        zoneId: row.zone_id,
        eventKey: 'evt-survivor',
        alertType: 'escalation',
        alertSubkey: 'step-2',
        decidedAtMs: Date.parse('2026-09-14T03:00:00Z'),
      },
    ]);
  });

  it('refuses a merge chain that did not end', () => {
    expect(() => decodeDarAlert({ ...row, resolved: false })).toThrow(/merge chain/);
  });

  it('refuses an alert type outside the registry', () => {
    expect(() => decodeDarAlert({ ...row, alert_type: 'all_clear' })).toThrow(/not known/);
  });
});

describe('has', () => {
  it('asks for the week under both versions', async () => {
    const db = stubDb({ rows: [{ present: 1 }] }, { rows: [] });
    const store = createPgQaReportStore(db);
    const query = { isoWeek: '2026-W38', metricsVersion: 'qa_metrics_v1', reportVersion: 'v' };
    expect(await store.has(query)).toBe(true);
    expect(await store.has(query)).toBe(false);
    expect(db.queries[0]?.values).toEqual(['2026-W38', 'qa_metrics_v1', 'v']);
  });
});

describe('save', () => {
  it('binds the ten columns in placeholder order', async () => {
    const db = stubDb({ rowCount: 1 });
    await createPgQaReportStore(db).save(REPORT);
    expect(db.queries[0]?.text).toBe(QA_REPORT_SQL.upsertReport);
    expect(db.queries[0]?.values).toEqual(saveParameters(REPORT));
    expect(saveParameters(REPORT)).toEqual([
      '2026-W38',
      '2026-09-14T00:00:00.000Z',
      '2026-09-21T00:00:00.000Z',
      'qa_metrics_v1',
      '43e53e7c',
      'qa_weekly_report_v1',
      '8cae3b34',
      '2026-09-21T00:05:00.000Z',
      REPORT.reportJson,
      REPORT.reportMarkdown,
    ]);
  });

  it('throws when the digest guard left the stored row alone', async () => {
    const db = stubDb({ rowCount: 0 });
    await expect(createPgQaReportStore(db).save(REPORT)).rejects.toThrow(/different digest/);
  });
});

describe('lifecycle history decoders (migration 020)', () => {
  const transition = {
    public_id: 'fw-2026-aaaaa',
    transitioned_at: new Date('2026-09-14T05:00:00Z'),
    from_status: 'active',
    to_status: 'no_longer_detected',
    status_reason: 'unobservable',
    max_frp_mw: 12.5,
    hull_area_ha: null,
    merged: false,
    reattached_at: null,
  };

  it('decodes a transition, keeping absent facts null', () => {
    expect(decodeTransition(transition)).toEqual({
      publicId: 'fw-2026-aaaaa',
      atMs: Date.parse('2026-09-14T05:00:00Z'),
      from: 'active',
      to: 'no_longer_detected',
      reason: 'unobservable',
      maxFrpMw: 12.5,
      hullAreaHa: null,
      merged: false,
      reattachedAtMs: null,
    });
    expect(decodeTransition({ ...transition, from_status: null }).from).toBe(null);
  });

  it('refuses a state outside the frozen vocabulary rather than counting it', () => {
    expect(() => decodeTransition({ ...transition, to_status: 'out' })).toThrow(
      /to_status is not a lifecycle state/,
    );
    expect(() =>
      decodePopulationRow({ public_id: 'fw-2026-aaaaa', status_at_start: 'extinguished' }),
    ).toThrow(/status_at_start/);
  });

  it('reads a population row whose event did not exist yet', () => {
    expect(decodePopulationRow({ public_id: 'fw-2026-aaaaa', status_at_start: null })).toEqual({
      publicId: 'fw-2026-aaaaa',
      statusAtStart: null,
    });
  });
});
