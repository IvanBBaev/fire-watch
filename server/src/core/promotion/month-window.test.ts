import { describe, expect, it } from 'vitest';

import { monthWindow } from './month-window.js';

describe('monthWindow', () => {
  it('derives the window and every table name from the month string', () => {
    expect(monthWindow('2020-07')).toEqual({
      month: '2020-07',
      startIso: '2020-07-01T00:00:00Z',
      endIso: '2020-08-01T00:00:00Z',
      startMs: Date.parse('2020-07-01T00:00:00Z'),
      endMs: Date.parse('2020-08-01T00:00:00Z'),
      livePartition: 'detections_2020_07',
      stagingTable: 'detections_2020_07_sp_staging',
      retiredTable: 'detections_2020_07_nrt_retired',
    });
  });

  it('rolls December into January of the next year', () => {
    const window = monthWindow('2025-12');
    expect(window.endIso).toBe('2026-01-01T00:00:00Z');
    expect(window.livePartition).toBe('detections_2025_12');
  });

  it('spans a leap February exactly', () => {
    const window = monthWindow('2020-02');
    expect(window.endIso).toBe('2020-03-01T00:00:00Z');
    expect(window.endMs - window.startMs).toBe(29 * 86_400_000);
  });

  it.each(['2020-13', '2020-00', '2020-1', '202-01', '2020/07', '2020-07-01', '', 'july'])(
    'refuses %j',
    (month) => {
      expect(() => monthWindow(month)).toThrow(RangeError);
    },
  );
});
