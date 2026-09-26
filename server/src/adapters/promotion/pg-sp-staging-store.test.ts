import { describe, expect, it } from 'vitest';

import {
  assertPromotionTable,
  partitionBoundLiteral,
  stagingInsertSql,
} from './pg-sp-staging-store.js';

describe('assertPromotionTable', () => {
  it.each([
    'detections_2020_07',
    'detections_2027_12',
    'detections_2020_07_sp_staging',
    'detections_2020_07_nrt_retired',
  ])('accepts %s', (name) => {
    expect(assertPromotionTable(name)).toBe(name);
  });

  it.each([
    'detections',
    'detections_2020_7',
    'detections_2020_00',
    'detections_2020_13',
    'detections_2020_07_evil',
    'detections_2020_07; DROP TABLE detections',
    'DETECTIONS_2020_07',
    ' detections_2020_07',
    '',
  ])('rejects %j', (name) => {
    expect(() => assertPromotionTable(name)).toThrow(RangeError);
  });
});

describe('partitionBoundLiteral', () => {
  it('quotes a month-boundary timestamp', () => {
    expect(partitionBoundLiteral('2020-07-01T00:00:00Z')).toBe("'2020-07-01T00:00:00Z'");
  });

  it.each([
    '2020-07-15T00:00:00Z',
    '2020-07-01T00:00:01Z',
    '2020-13-01T00:00:00Z',
    "2020-07-01T00:00:00Z'; DROP TABLE detections; --",
    '',
  ])('rejects %j', (iso) => {
    expect(() => partitionBoundLiteral(iso)).toThrow(RangeError);
  });
});

describe('stagingInsertSql', () => {
  it('targets the staging table with a batched, conflict-ignoring insert', () => {
    const sql = stagingInsertSql('detections_2020_07_sp_staging');
    expect(sql).toContain('INSERT INTO detections_2020_07_sp_staging (');
    expect(sql).toContain('unnest(');
    expect(sql).toContain('ON CONFLICT (acq_ts, detection_uid) DO NOTHING');
    // The 19 record columns arrive as 19 typed array parameters.
    expect(sql.match(/\$\d+::\w+\[\]/gu)).toHaveLength(19);
    expect(sql).toContain('$1::text[]');
    expect(sql).toContain('$19::boolean[]');
  });

  it('refuses a table name outside the promotion grammar', () => {
    expect(() => stagingInsertSql('detections; --')).toThrow(RangeError);
  });
});
