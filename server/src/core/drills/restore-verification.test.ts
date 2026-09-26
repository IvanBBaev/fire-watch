import { describe, expect, it } from 'vitest';

import type { TableGauge } from '../backup/table-gauges.js';
import { compareRestoredRows } from './restore-verification.js';

const GAUGES: TableGauge[] = [
  { relation: 'fire_events', rows: 120, bytes: 1, set: 'main' },
  { relation: 'accounts', rows: 3, bytes: 1, set: 'personal' },
];

describe('compareRestoredRows', () => {
  it('passes when every gauged table holds exactly its rows', () => {
    const result = compareRestoredRows(
      GAUGES,
      [
        { relation: 'fire_events', backupClass: 'main', rows: 120 },
        { relation: 'accounts', backupClass: 'personal', rows: 3 },
        { relation: 'schema_less', backupClass: null, rows: 0 },
      ],
      true,
    );
    expect(result.check.status).toBe('pass');
    expect(result.matched).toBe(2);
  });

  it('expects personal tables empty when the companion was not restored', () => {
    const result = compareRestoredRows(
      GAUGES,
      [
        { relation: 'fire_events', backupClass: 'main', rows: 120 },
        { relation: 'accounts', backupClass: 'personal', rows: 0 },
      ],
      false,
    );
    expect(result.check.status).toBe('pass');
    expect(result.check.detail).toMatch(/companion not restored/);
  });

  it('reports a short table, a missing table and an ungauged table with rows', () => {
    const result = compareRestoredRows(
      GAUGES,
      [
        { relation: 'fire_events', backupClass: 'main', rows: 119 },
        { relation: 'excluded_cache', backupClass: null, rows: 5 },
      ],
      true,
    );
    expect(result.check.status).toBe('fail');
    expect(result.mismatches).toEqual([
      { relation: 'accounts', expected: 3, restored: null },
      { relation: 'fire_events', expected: 120, restored: 119 },
      { relation: 'excluded_cache', expected: null, restored: 5 },
    ]);
  });

  it('is not_run without gauges or without restored counts', () => {
    expect(compareRestoredRows(null, [], true).check.status).toBe('not_run');
    expect(compareRestoredRows(GAUGES, null, true).check.status).toBe('not_run');
  });
});
