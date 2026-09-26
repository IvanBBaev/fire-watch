import { describe, expect, it } from 'vitest';

import { planBackupRun } from './dump-plan.js';
import {
  BACKUP_TABLE_BYTES,
  BACKUP_TABLE_METRICS,
  BACKUP_TABLE_ROWS,
  backupTableGauges,
  compareTableGauges,
  parseTableGaugeSnapshot,
  type TableGauge,
} from './table-gauges.js';

const PLAN = planBackupRun({
  relations: [
    { relation: 'detections', backupClass: 'main' },
    { relation: 'schema_migrations', backupClass: 'main' },
    { relation: 'accounts', backupClass: 'personal' },
    { relation: 'mystery', backupClass: null },
  ],
  snapshotId: '00000003-0000001B-1',
  takenAtMs: Date.parse('2026-09-24T02:20:00Z'),
});

describe('table gauge series', () => {
  it('declares two gauges labelled by relation and set', () => {
    expect(BACKUP_TABLE_METRICS).toEqual([BACKUP_TABLE_ROWS, BACKUP_TABLE_BYTES]);
    for (const metric of BACKUP_TABLE_METRICS) {
      expect(metric.kind).toBe('gauge');
      expect(metric.name).toMatch(/^fw_backup_table_[a-z]+$/);
      expect(metric.labels).toEqual(['relation', 'set']);
    }
  });
});

describe('backupTableGauges', () => {
  it('labels each table with the artifact carrying its rows, sorted by relation', () => {
    const result = backupTableGauges(
      [
        { relation: 'mystery', rows: 1, bytes: 8192 },
        { relation: 'detections', rows: 1500, bytes: 2_000_000 },
        { relation: 'accounts', rows: 2, bytes: 16_384 },
        { relation: 'schema_migrations', rows: 13, bytes: 8192 },
      ],
      PLAN,
    );
    expect(result.gauges).toEqual([
      { relation: 'accounts', set: 'personal', rows: 2, bytes: 16_384 },
      { relation: 'detections', set: 'main', rows: 1500, bytes: 2_000_000 },
      // Unclassified tables ride in the personal set (fail-closed), and are gauged there.
      { relation: 'mystery', set: 'personal', rows: 1, bytes: 8192 },
      { relation: 'schema_migrations', set: 'main', rows: 13, bytes: 8192 },
    ]);
    expect(result.unplanned).toEqual([]);
  });

  it('reports a table the plan does not name instead of guessing its set', () => {
    const result = backupTableGauges(
      [
        { relation: 'zz_new', rows: 5, bytes: 1 },
        { relation: 'detections', rows: 1, bytes: 1 },
        { relation: 'aa_new', rows: 0, bytes: 1 },
      ],
      PLAN,
    );
    expect(result.gauges.map((g) => g.relation)).toEqual(['detections']);
    expect(result.unplanned).toEqual(['aa_new', 'zz_new']);
  });

  it('refuses a malformed, negative, fractional or duplicated stat', () => {
    expect(() => backupTableGauges([{ relation: 'Bad', rows: 1, bytes: 1 }], PLAN)).toThrow(
      /plain identifier/,
    );
    expect(() => backupTableGauges([{ relation: 'accounts', rows: -1, bytes: 1 }], PLAN)).toThrow(
      /rows of accounts/,
    );
    expect(() => backupTableGauges([{ relation: 'accounts', rows: 1.5, bytes: 1 }], PLAN)).toThrow(
      /rows of accounts/,
    );
    expect(() =>
      backupTableGauges([{ relation: 'accounts', rows: 1, bytes: Number.NaN }], PLAN),
    ).toThrow(/bytes of accounts/);
    expect(() =>
      backupTableGauges(
        [
          { relation: 'accounts', rows: 1, bytes: 1 },
          { relation: 'accounts', rows: 1, bytes: 1 },
        ],
        PLAN,
      ),
    ).toThrow(/listed twice/);
  });
});

describe('compareTableGauges', () => {
  const tonight: TableGauge[] = [
    { relation: 'accounts', set: 'personal', rows: 2, bytes: 16_384 },
    { relation: 'detections', set: 'main', rows: 900, bytes: 2_000_000 },
    { relation: 'fire_events', set: 'main', rows: 40, bytes: 64_000 },
  ];

  it('names every table that lost rows and every one that disappeared', () => {
    const result = compareTableGauges(
      {
        takenAt: '2026-09-23T02:20:00Z',
        gauges: [
          { relation: 'detections', set: 'main', rows: 1500, bytes: 2_100_000 },
          { relation: 'accounts', set: 'personal', rows: 3, bytes: 16_384 },
          { relation: 'fire_events', set: 'main', rows: 30, bytes: 60_000 },
          { relation: 'detections_2026_08_nrt', set: 'main', rows: 10, bytes: 8192 },
        ],
      },
      tonight,
    );
    expect(result).toEqual({
      previousTakenAt: '2026-09-23T02:20:00Z',
      shrunk: [
        { relation: 'accounts', set: 'personal', previousRows: 3, rows: 2 },
        { relation: 'detections', set: 'main', previousRows: 1500, rows: 900 },
      ],
      vanished: ['detections_2026_08_nrt'],
    });
  });

  it('reports nothing when every table held or grew, and ignores new tables', () => {
    const result = compareTableGauges(
      {
        takenAt: '2026-09-23T02:20:00Z',
        gauges: [{ relation: 'detections', set: 'main', rows: 900, bytes: 1 }],
      },
      tonight,
    );
    expect(result.shrunk).toEqual([]);
    expect(result.vanished).toEqual([]);
  });
});

describe('parseTableGaugeSnapshot', () => {
  const valid = {
    takenAt: '2026-09-23T02:20:00Z',
    gauges: [{ relation: 'detections', set: 'main', rows: 1, bytes: 2 }],
  };

  it('reads back what the ledger writes', () => {
    expect(parseTableGaugeSnapshot(valid)).toEqual(valid);
  });

  it('answers null for anything that is not a snapshot', () => {
    expect(parseTableGaugeSnapshot(null)).toBeNull();
    expect(parseTableGaugeSnapshot('x')).toBeNull();
    expect(parseTableGaugeSnapshot({ ...valid, takenAt: 'yesterday' })).toBeNull();
    expect(parseTableGaugeSnapshot({ ...valid, gauges: {} })).toBeNull();
    expect(parseTableGaugeSnapshot({ ...valid, gauges: [null] })).toBeNull();
    const entry = valid.gauges[0];
    for (const bad of [
      { ...entry, relation: 'Bad Name' },
      { ...entry, set: 'weekly' },
      { ...entry, rows: -1 },
      { ...entry, bytes: '2' },
    ]) {
      expect(parseTableGaugeSnapshot({ ...valid, gauges: [bad] })).toBeNull();
    }
    expect(parseTableGaugeSnapshot({ ...valid, gauges: [entry, entry] })).toBeNull();
  });
});
