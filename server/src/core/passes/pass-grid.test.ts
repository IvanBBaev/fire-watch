import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import {
  PASS_BUCKET_MS,
  PASS_CELL_DEG,
  cellFor,
  parseCellId,
  passBucketStart,
  passWindowFor,
} from './pass-grid.js';

const box = POLLING_BBOX.values;

describe('pass grid', () => {
  it('names a cell by its centre, two decimals, latitude first', () => {
    expect(cellFor({ lat: 42.6977, lon: 23.3219 })?.id).toBe('42.75_23.25');
    expect(cellFor({ lat: 42.5, lon: 23.0 })?.id).toBe('42.75_23.25');
    expect(cellFor({ lat: 42.4999, lon: 22.9999 })?.id).toBe('42.25_22.75');
  });

  it('serves only cells inside the polling box', () => {
    expect(cellFor({ lat: 48.2, lon: 16.4 })).toBeNull();
    expect(cellFor({ lat: Number.NaN, lon: 25 })).toBeNull();
    expect(parseCellId('48.25_16.25')).toBeNull();
  });

  it.each([
    '42.7_23.3',
    '42.750_23.25',
    '42.70_23.30',
    '42.75_23.25 ',
    '+42.75_23.25',
    '42.75-23.25',
  ])('refuses the non-canonical id %j', (id) => expect(parseCellId(id)).toBeNull());

  it('property: a point is inside its cell, and the cell id round-trips', () => {
    fc.assert(
      fc.property(
        fc.double({ min: box.south, max: box.north, noNaN: true }),
        fc.double({ min: box.west, max: box.east, noNaN: true }),
        (lat, lon) => {
          const cell = cellFor({ lat, lon });
          if (cell === null) return;
          expect(Math.abs(cell.centre.lat - lat)).toBeLessThanOrEqual(PASS_CELL_DEG / 2);
          expect(Math.abs(cell.centre.lon - lon)).toBeLessThanOrEqual(PASS_CELL_DEG / 2);
          expect(parseCellId(cell.id)).toEqual(cell);
        },
      ),
    );
  });

  it('buckets time into ten-minute steps and looks 12 h back, 24 h ahead', () => {
    const now = Date.UTC(2026, 8, 30, 13, 17, 42);
    const bucket = passBucketStart(now);
    expect(bucket).toBe(Date.UTC(2026, 8, 30, 13, 10));
    expect(passBucketStart(bucket + PASS_BUCKET_MS - 1)).toBe(bucket);
    expect(passWindowFor(bucket)).toEqual({
      fromMs: Date.UTC(2026, 8, 30, 1, 10),
      toMs: Date.UTC(2026, 9, 1, 13, 10),
    });
  });
});
