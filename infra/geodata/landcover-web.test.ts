import { describe, expect, it } from 'vitest';

import {
  GROUPS,
  LANDCOVER_WEB_FORMAT,
  PLANE_GROUP,
  buildLandCoverWeb,
  quantizeShares,
  serializeLandCoverWeb,
} from './landcover-web.js';
import { CLASSES } from './worldcover.js';

const OPTIONS = {
  factor: 2,
  scale: 10,
  version: 'test_v',
  source: 'test',
  licence: 'CC BY 4.0',
  attribution: 'credit',
  productSha256: 'abc',
};

/** One product cell's twelve planes from `{classCode: share}` (shares of 250). */
function cell(shares: Readonly<Record<number, number>>): number[] {
  return CLASSES.map((code) => shares[code] ?? 0);
}

/** A product of `cols × rows` cells, row-major, north row first. */
function product(cells: readonly number[][]): Uint8Array {
  return Uint8Array.from(cells.flat());
}

const LAYOUT = { west: 20, north: 46, cellDeg: 0.005, cols: 4, rows: 2 };

describe('PLANE_GROUP', () => {
  it('maps every class but no-data to a group, and no-data to none', () => {
    expect(PLANE_GROUP).toHaveLength(CLASSES.length);
    expect(PLANE_GROUP[0]).toBeNull();
    expect(PLANE_GROUP.slice(1).every((g) => g !== null && g < GROUPS.length)).toBe(true);
    // tree 10, crop 40, wetland 90 land in their own groups
    expect(PLANE_GROUP[CLASSES.indexOf(10)]).toBe(GROUPS.indexOf('tree'));
    expect(PLANE_GROUP[CLASSES.indexOf(40)]).toBe(GROUPS.indexOf('crop'));
    expect(PLANE_GROUP[CLASSES.indexOf(90)]).toBe(GROUPS.indexOf('wetland'));
    expect(PLANE_GROUP[CLASSES.indexOf(100)]).toBe(GROUPS.indexOf('grass'));
    expect(PLANE_GROUP[CLASSES.indexOf(70)]).toBe(GROUPS.indexOf('bare'));
  });
});

describe('quantizeShares', () => {
  it('sums to the scale by largest remainder, ties to the lower index', () => {
    expect(quantizeShares([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(quantizeShares([2, 1, 0], 10)).toEqual([7, 3, 0]);
    expect(quantizeShares([5, 0, 5], 10)).toEqual([5, 0, 5]);
  });

  it('is empty when nothing has weight', () => {
    expect(quantizeShares([0, 0], 10)).toEqual([]);
  });
});

describe('buildLandCoverWeb', () => {
  it('pools blocks, leaves no-data out of the denominator and run-length encodes rows', () => {
    const forest = cell({ 10: 250 });
    const crop = cell({ 40: 250 });
    const sea = cell({ 0: 250 });
    const halfSea = cell({ 0: 125, 10: 125 });
    // 4×2 product cells → 2×1 asset cells: the west block is forest with a half-sea cell,
    // the east block is all crop.
    const asset = buildLandCoverWeb(
      product([forest, halfSea, crop, crop, forest, sea, crop, crop]),
      LAYOUT,
      OPTIONS,
    );
    expect(asset.format).toBe(LANDCOVER_WEB_FORMAT);
    expect(asset.grid).toEqual({
      west: 20,
      north: 46,
      cell_deg: 0.01,
      cols: 2,
      rows: 1,
      scale: 10,
    });
    expect(asset.groups).toEqual(GROUPS);
    const tree = [10, 0, 0, 0, 0, 0, 0, 0];
    const crops = [0, 0, 0, 10, 0, 0, 0, 0];
    // Ties in frequency are ordered by key: "0,0,0,10,…" sorts before "10,0,…".
    expect(asset.palette).toEqual([crops, tree]);
    expect(asset.rows).toEqual([[1, 1, 0, 1]]);
    expect(asset.counts).toEqual({ cells: 2, empty: 0, palette: 2 });
  });

  it('marks a block with no data as empty and puts the most frequent vector first', () => {
    const sea = cell({ 0: 250 });
    const mixed = cell({ 10: 150, 30: 100 });
    const asset = buildLandCoverWeb(
      product([sea, sea, sea, sea, sea, sea, mixed, mixed]),
      { ...LAYOUT, cols: 4, rows: 2 },
      { ...OPTIONS, factor: 1 },
    );
    expect(asset.grid.cols).toBe(4);
    expect(asset.grid.rows).toBe(2);
    expect(asset.palette[0]).toEqual([]);
    expect(asset.palette[1]).toEqual([6, 0, 4, 0, 0, 0, 0, 0]);
    expect(asset.rows).toEqual([
      [0, 4],
      [0, 2, 1, 2],
    ]);
    expect(asset.counts.empty).toBe(6);
  });

  it('pools a partial block at the east and south edges from the cells it has', () => {
    const asset = buildLandCoverWeb(
      product([cell({ 50: 250 }), cell({ 80: 250 }), cell({ 60: 250 })]),
      { ...LAYOUT, cols: 3, rows: 1 },
      OPTIONS,
    );
    expect(asset.grid.cols).toBe(2);
    expect(asset.grid.rows).toBe(1);
    const decoded = asset.rows[0] ?? [];
    expect(asset.palette[decoded[0] ?? -1]).toEqual([0, 0, 0, 0, 5, 0, 5, 0]);
    expect(asset.palette[decoded[2] ?? -1]).toEqual([0, 0, 0, 0, 0, 10, 0, 0]);
  });

  it('rejects a product of the wrong size and a bad factor', () => {
    expect(() => buildLandCoverWeb(new Uint8Array(5), LAYOUT, OPTIONS)).toThrow(/expected/);
    expect(() =>
      buildLandCoverWeb(product(new Array(8).fill(cell({ 10: 250 }))), LAYOUT, {
        ...OPTIONS,
        factor: 0,
      }),
    ).toThrow(/factor/);
  });

  it('serialises to JSON that parses back to the same asset', () => {
    const asset = buildLandCoverWeb(
      product(new Array(8).fill(cell({ 10: 200, 40: 50 }))),
      LAYOUT,
      OPTIONS,
    );
    const text = serializeLandCoverWeb(asset);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(asset)));
    expect(text.endsWith(']}\n')).toBe(true);
  });
});
