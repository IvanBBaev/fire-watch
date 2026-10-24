import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  LAND_COVER_FORMAT,
  LAND_COVER_GROUPS,
  LandCoverFormatError,
  landCoverCell,
  landCoverMix,
  landCoverParts,
  parseLandCover,
} from './land-cover.js';

const FOREST = [10, 0, 0, 0, 0, 0, 0, 0];
const CROP = [0, 0, 0, 10, 0, 0, 0, 0];
const MIXED = [6, 0, 3, 1, 0, 0, 0, 0];

/** A 3×2 grid of 0.02° cells from (20, 46): row 0 forest, empty, crop; row 1 mixed ×3. */
function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: LAND_COVER_FORMAT,
    version: 'test_v',
    source: 'test',
    licence: 'CC BY 4.0',
    attribution: 'credit',
    product_sha256: 'abc',
    grid: { west: 20, north: 46, cell_deg: 0.02, cols: 3, rows: 2, scale: 10 },
    groups: [...LAND_COVER_GROUPS],
    palette: [MIXED, FOREST, [], CROP],
    rows: [
      [1, 1, 2, 1, 3, 1],
      [0, 3],
    ],
    counts: { cells: 6, empty: 1, palette: 4 },
    ...overrides,
  };
}

const GRID = parseLandCover(asset());

/** The centre of cell (col, row). */
function at(col: number, row: number): { lon: number; lat: number } {
  return { lon: 20 + 0.02 * col + 0.01, lat: 46 - 0.02 * row - 0.01 };
}

describe('parseLandCover', () => {
  it('decodes the run-length rows into one palette index per cell', () => {
    expect([...GRID.cells]).toEqual([1, 2, 3, 0, 0, 0]);
    expect(GRID.cols).toBe(3);
    expect(GRID.rows).toBe(2);
    expect(GRID.cellDeg).toBe(0.02);
    expect(GRID.attribution).toBe('credit');
  });

  it.each([
    ['a wrong format', { format: 'x' }],
    ['groups out of order', { groups: ['shrub', 'tree', ...LAND_COVER_GROUPS.slice(2)] }],
    ['a palette entry that does not sum to the scale', { palette: [[1, 0, 0, 0, 0, 0, 0, 0]] }],
    ['a palette entry of the wrong length', { palette: [[10]] }],
    ['a negative share', { palette: [[11, -1, 0, 0, 0, 0, 0, 0]] }],
    ['too few rows', { rows: [[0, 3]] }],
    [
      'a short row',
      {
        rows: [
          [1, 1],
          [0, 3],
        ],
      },
    ],
    [
      'a row that runs over',
      {
        rows: [
          [1, 4],
          [0, 3],
        ],
      },
    ],
    [
      'an index out of range',
      {
        rows: [
          [9, 3],
          [0, 3],
        ],
      },
    ],
    [
      'a zero-length run',
      {
        rows: [
          [1, 0, 1, 3],
          [0, 3],
        ],
      },
    ],
    [
      'a bad cell size',
      { grid: { west: 20, north: 46, cell_deg: 0, cols: 3, rows: 2, scale: 10 } },
    ],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseLandCover(asset(overrides))).toThrow(LandCoverFormatError);
  });

  it('rejects a non-object', () => {
    expect(() => parseLandCover(null)).toThrow(LandCoverFormatError);
  });
});

describe('landCoverCell', () => {
  it('finds the cell from the north-west corner and nothing outside the grid', () => {
    expect(landCoverCell(GRID, at(0, 0))).toBe(0);
    expect(landCoverCell(GRID, at(2, 1))).toBe(5);
    expect(landCoverCell(GRID, { lon: 19.99, lat: 45.99 })).toBeNull();
    expect(landCoverCell(GRID, { lon: 20.01, lat: 46.01 })).toBeNull();
    expect(landCoverCell(GRID, { lon: 20.07, lat: 45.99 })).toBeNull();
    expect(landCoverCell(GRID, { lon: Number.NaN, lat: 45.99 })).toBeNull();
  });
});

describe('landCoverMix', () => {
  it('describes one cell by its own shares', () => {
    expect(landCoverMix(GRID, [at(0, 1)])).toEqual({
      cells: 1,
      shares: [
        { group: 'tree', share: 0.6 },
        { group: 'grass', share: 0.3 },
        { group: 'crop', share: 0.1 },
      ],
    });
  });

  it('averages distinct cells, so repeated detections in one cell count once', () => {
    const forest = at(0, 0);
    const crop = at(2, 0);
    const mix = landCoverMix(GRID, [
      forest,
      forest,
      forest,
      { ...forest, lon: forest.lon + 0.001 },
      crop,
    ]);
    expect(mix).toEqual({
      cells: 2,
      shares: [
        { group: 'tree', share: 0.5 },
        { group: 'crop', share: 0.5 },
      ],
    });
  });

  it('leaves out empty cells and points outside the grid', () => {
    const mix = landCoverMix(GRID, [at(1, 0), { lon: 10, lat: 10 }, at(0, 0)]);
    expect(mix?.cells).toBe(1);
    expect(mix?.shares).toEqual([{ group: 'tree', share: 1 }]);
  });

  it('has no answer when no point lands on a cell with data', () => {
    expect(landCoverMix(GRID, [at(1, 0), { lon: 10, lat: 10 }])).toBeNull();
    expect(landCoverMix(GRID, [])).toBeNull();
  });
});

describe('landCoverParts', () => {
  it('rounds to tens, drops what rounds to zero and keeps the order', () => {
    expect(
      landCoverParts({
        cells: 4,
        shares: [
          { group: 'tree', share: 0.475 },
          { group: 'crop', share: 0.35 },
          { group: 'grass', share: 0.15 },
          { group: 'built', share: 0.025 },
        ],
      }),
    ).toEqual([
      { group: 'tree', percent: 50 },
      { group: 'crop', percent: 40 },
      { group: 'grass', percent: 20 },
    ]);
  });

  it('names at most four groups', () => {
    const shares = LAND_COVER_GROUPS.slice(0, 6).map((group, i) => ({
      group,
      share: 0.3 - i * 0.04,
    }));
    expect(landCoverParts({ cells: 9, shares }).map((part) => part.group)).toEqual([
      'tree',
      'shrub',
      'grass',
      'crop',
    ]);
  });

  it('is empty when every share rounds to zero', () => {
    expect(landCoverParts({ cells: 1, shares: [{ group: 'tree', share: 0.04 }] })).toEqual([]);
  });
});

describe('the shipped land-cover asset', () => {
  const shipped = parseLandCover(
    JSON.parse(
      readFileSync(new URL('../../assets/geodata/landcover.json', import.meta.url), 'utf8'),
    ) as unknown,
  );
  const top = (lon: number, lat: number) =>
    landCoverParts(landCoverMix(shipped, [{ lon, lat }]) ?? { cells: 0, shares: [] })[0]?.group;

  it('covers the served box at 0.02 degrees', () => {
    expect(shipped.version).toBe('worldcover_2021_v200_0p005_web_0p02_s10');
    expect([shipped.west, shipped.north, shipped.cols, shipped.rows]).toEqual([20, 46, 550, 350]);
    expect(shipped.cellDeg).toBe(0.02);
  });

  it('knows a forest, a city, a field plain and the open sea', () => {
    expect(top(27.75, 42.05)).toBe('tree'); // Strandzha
    expect(top(23.3219, 42.6977)).toBe('built'); // the centre of Sofia
    expect(top(27.3, 43.75)).toBe('crop'); // Dobrudzha
    expect(landCoverMix(shipped, [{ lon: 30.5, lat: 43.0 }])).toBeNull(); // the Black Sea
  });
});
