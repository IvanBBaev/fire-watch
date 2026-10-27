import { describe, expect, it } from 'vitest';

import {
  GIBS_SAME_DAY_READY_UTC_HOUR,
  MAX_SHIFT_DAYS,
  TILE_CSS_PX,
  addDays,
  canShift,
  comparisonDates,
  comparisonTiles,
  gibsTileUrl,
  latestAvailableDay,
  shiftDate,
} from './before-after.js';

const at = (iso: string): number => Date.parse(iso);

describe('latestAvailableDay', () => {
  it('offers yesterday until the same-day mosaic is taken to be published', () => {
    const hour = String(GIBS_SAME_DAY_READY_UTC_HOUR - 1).padStart(2, '0');
    expect(latestAvailableDay(at(`2026-08-10T${hour}:59:59Z`))).toBe('2026-08-09');
  });

  it('offers today from the readiness hour on', () => {
    const hour = String(GIBS_SAME_DAY_READY_UTC_HOUR).padStart(2, '0');
    expect(latestAvailableDay(at(`2026-08-10T${hour}:00:00Z`))).toBe('2026-08-10');
  });

  it('crosses month and year boundaries', () => {
    expect(latestAvailableDay(at('2027-01-01T03:00:00Z'))).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('comparisonDates', () => {
  it('a closed event: the day before the first and the day after the last detection', () => {
    const dates = comparisonDates(
      '2026-08-03T11:20:00Z',
      '2026-08-06T23:50:00Z',
      at('2026-08-20T12:00:00Z'),
    );
    expect(dates).toMatchObject({
      before: '2026-08-02',
      after: '2026-08-07',
      afterKind: 'after-last',
      lastDetectionDay: '2026-08-06',
      beforeRange: { earliest: addDays('2026-08-02', -MAX_SHIFT_DAYS), latest: '2026-08-02' },
      afterRange: { earliest: '2026-08-07', latest: '2026-08-19' },
    });
  });

  it('caps how far "after" may be stepped at MAX_SHIFT_DAYS past the rule day', () => {
    const dates = comparisonDates(
      '2026-05-01T10:00:00Z',
      '2026-05-02T10:00:00Z',
      at('2026-10-01T20:00:00Z'),
    );
    expect(dates?.afterRange).toEqual({
      earliest: '2026-05-03',
      latest: addDays('2026-05-03', MAX_SHIFT_DAYS),
    });
  });

  it('days are UTC days, not Sofia days', () => {
    // 23:30 UTC on the 5th is already the 6th in Sofia; GIBS days are UTC.
    const dates = comparisonDates(
      '2026-08-05T23:30:00Z',
      '2026-08-05T23:30:00Z',
      at('2026-08-20T12:00:00Z'),
    );
    expect(dates?.before).toBe('2026-08-04');
    expect(dates?.after).toBe('2026-08-06');
  });

  it('an active event: "after" is the newest available day, labelled as not after the fire', () => {
    const dates = comparisonDates(
      '2026-08-08T11:00:00Z',
      '2026-08-10T11:30:00Z',
      at('2026-08-10T14:00:00Z'),
    );
    expect(dates).toMatchObject({
      before: '2026-08-07',
      after: '2026-08-09',
      afterKind: 'latest',
      afterRange: { earliest: '2026-08-09', latest: '2026-08-09' },
    });
  });

  it('the day after the last detection, before its mosaic exists, falls back to the newest day', () => {
    const dates = comparisonDates(
      '2026-08-08T11:00:00Z',
      '2026-08-09T11:30:00Z',
      at('2026-08-10T14:00:00Z'),
    );
    // The 10th's mosaic is not taken to exist before the readiness hour.
    expect(dates).toMatchObject({ after: '2026-08-09', afterKind: 'latest' });
  });

  it('never offers a "before" on or after the "after" day', () => {
    // First seen yesterday; only yesterday is available: no pair of distinct days before it.
    const dates = comparisonDates(
      '2026-08-09T11:00:00Z',
      '2026-08-09T11:00:00Z',
      at('2026-08-10T10:00:00Z'),
    );
    expect(dates).toMatchObject({ before: '2026-08-08', after: '2026-08-09' });
    expect(dates !== null && dates.before < dates.after).toBe(true);
  });

  it('null when no newer day than the one before the first detection is available', () => {
    expect(
      comparisonDates('2026-08-10T11:00:00Z', '2026-08-10T11:00:00Z', at('2026-08-10T12:00:00Z')),
    ).toBeNull();
  });

  it('null on unparseable instants or clock', () => {
    const now = at('2026-08-20T12:00:00Z');
    expect(comparisonDates('nope', '2026-08-06T00:00:00Z', now)).toBeNull();
    expect(comparisonDates('2026-08-06T00:00:00Z', '', now)).toBeNull();
    expect(comparisonDates('2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z', NaN)).toBeNull();
  });

  it('tolerates first and last swapped', () => {
    const now = at('2026-08-20T12:00:00Z');
    expect(comparisonDates('2026-08-06T10:00:00Z', '2026-08-03T10:00:00Z', now)).toEqual(
      comparisonDates('2026-08-03T10:00:00Z', '2026-08-06T10:00:00Z', now),
    );
  });
});

describe('shiftDate', () => {
  const now = at('2026-08-20T12:00:00Z');
  const dates = comparisonDates('2026-08-03T11:20:00Z', '2026-08-06T23:50:00Z', now);
  if (dates === null) throw new Error('fixture dates');

  it('steps "before" earlier but never past the first detection', () => {
    expect(shiftDate(dates, 'before', -1).before).toBe('2026-08-01');
    expect(shiftDate(dates, 'before', 1)).toBe(dates);
    expect(canShift(dates, 'before', 1)).toBe(false);
    expect(canShift(dates, 'before', -1)).toBe(true);
  });

  it('stops "before" at the range floor', () => {
    let moved = dates;
    for (let i = 0; i < MAX_SHIFT_DAYS + 5; i += 1) moved = shiftDate(moved, 'before', -1);
    expect(moved.before).toBe(dates.beforeRange.earliest);
    expect(canShift(moved, 'before', -1)).toBe(false);
  });

  it('steps "after" later up to the newest available day, never before the day after the fire', () => {
    expect(shiftDate(dates, 'after', -1)).toBe(dates);
    const later = shiftDate(dates, 'after', 1);
    expect(later).toMatchObject({ after: '2026-08-08', afterKind: 'after-last' });
    let moved = later;
    for (let i = 0; i < 40; i += 1) moved = shiftDate(moved, 'after', 1);
    expect(moved.after).toBe('2026-08-19');
  });

  it('an active event has one "after" day and nothing to step', () => {
    const active = comparisonDates(
      '2026-08-08T11:00:00Z',
      '2026-08-10T11:30:00Z',
      at('2026-08-10T14:00:00Z'),
    );
    if (active === null) throw new Error('fixture');
    expect(canShift(active, 'after', 1)).toBe(false);
    expect(canShift(active, 'after', -1)).toBe(false);
  });
});

describe('comparisonTiles', () => {
  it('covers the view around the centre with z9 tiles, the centre inside one of them', () => {
    // Near Stara Zagora.
    const tiles = comparisonTiles(25.6, 42.4, 300, 200);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((tile) => tile.z === 9)).toBe(true);
    const holding = tiles.filter(
      (tile) =>
        tile.leftPx <= 0 &&
        tile.leftPx + TILE_CSS_PX > 0 &&
        tile.topPx <= 0 &&
        tile.topPx + TILE_CSS_PX > 0,
    );
    expect(holding).toHaveLength(1);
    // lon 25.6 → x = floor((205.6/360)·512) = 292; lat 42.4 → y = 189.
    expect(holding[0]).toMatchObject({ x: 292, y: 189 });
  });

  it('spans the whole requested view', () => {
    const tiles = comparisonTiles(25.6, 42.4, 300, 200);
    const left = Math.min(...tiles.map((tile) => tile.leftPx));
    const right = Math.max(...tiles.map((tile) => tile.leftPx + TILE_CSS_PX));
    const top = Math.min(...tiles.map((tile) => tile.topPx));
    const bottom = Math.max(...tiles.map((tile) => tile.topPx + TILE_CSS_PX));
    expect(left).toBeLessThanOrEqual(-300);
    expect(right).toBeGreaterThanOrEqual(300);
    expect(top).toBeLessThanOrEqual(-200);
    expect(bottom).toBeGreaterThanOrEqual(200);
  });

  it('wraps columns at the antimeridian', () => {
    const tiles = comparisonTiles(179.99, 0, 300, 10);
    expect(tiles.some((tile) => tile.x === 0)).toBe(true);
    expect(tiles.every((tile) => tile.x >= 0 && tile.x < 512)).toBe(true);
  });

  it('drops rows outside the matrix near the poles', () => {
    const tiles = comparisonTiles(0, 89, 10, 600);
    expect(tiles.every((tile) => tile.y >= 0 && tile.y < 512)).toBe(true);
  });
});

describe('gibsTileUrl', () => {
  it('builds the keyless WMTS REST URL: day, then z/row/col', () => {
    expect(gibsTileUrl('2026-08-07', { z: 9, x: 292, y: 189 })).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
        'VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-08-07/' +
        'GoogleMapsCompatible_Level9/9/189/292.jpg',
    );
  });
});
