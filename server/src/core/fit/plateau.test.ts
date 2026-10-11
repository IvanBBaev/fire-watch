import { describe, expect, it } from 'vitest';

import type { GridCell, GridSlice } from './fit-grid.js';
import { selectPlateau, type CellScore, type PlateauTolerances } from './plateau.js';

const TOL: PlateauTolerances = { eventCountTolerance: 0.1, f1Tolerance: 0.01 };

function cell(slice: GridSlice, index: readonly number[]): GridCell {
  return {
    id: `${slice}/${index.join('.')}`,
    slice,
    index,
    epsViirsKm: 1,
    epsModisKm: slice === 'modis_fixed' ? 3 : null,
    tLinkHours: 48,
  };
}

function score(
  slice: GridSlice,
  index: readonly number[],
  meetsTargets: boolean,
  over: Partial<Pick<CellScore, 'eventCount' | 'f1'>> = {},
): CellScore {
  return {
    cell: cell(slice, index),
    eventCount: over.eventCount ?? 100,
    f1: over.f1 === undefined ? 0.97 : over.f1,
    meetsTargets,
  };
}

/** A 1-D slice of `n` cells, acceptable exactly at `good` (all equally stable). */
function line(n: number, good: readonly number[], slice: GridSlice = 'modis_footprint') {
  return Array.from({ length: n }, (_, i) => score(slice, [i], good.includes(i)));
}

function square(n: number, meets: (i: number, j: number) => boolean): CellScore[] {
  const out: CellScore[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) out.push(score('modis_footprint', [i, j], meets(i, j)));
  }
  return out;
}

describe('selectPlateau', () => {
  it('selects nothing when no cell is acceptable — there is no least-bad fallback', () => {
    const result = selectPlateau(line(5, []), { modis_footprint: [5] }, TOL);
    expect(result.selected).toBeNull();
    expect(result.regions).toEqual([]);
    expect(result.cells.every((c) => !c.acceptable && c.inradius === null)).toBe(true);
  });

  it('picks the centre of a uniform grid', () => {
    const result = selectPlateau(
      square(5, () => true),
      { modis_footprint: [5, 5] },
      TOL,
    );
    expect(result.selected).toEqual({
      cellId: 'modis_footprint/2.2',
      slice: 'modis_footprint',
      index: [2, 2],
      regionCells: 25,
      width: 2,
    });
    // Edges have inradius 0: the grid edge is where evidence stops.
    expect(result.cells.find((c) => c.cellId === 'modis_footprint/0.3')?.inradius).toBe(0);
    expect(result.cells.find((c) => c.cellId === 'modis_footprint/1.1')?.inradius).toBe(1);
  });

  it('never picks a lone argmax spike, and the spike destabilises its neighbours', () => {
    const scores = square(5, () => true).map((s) =>
      s.cell.index[0] === 0 && s.cell.index[1] === 0 ? { ...s, f1: 0.99 } : s,
    );
    const result = selectPlateau(scores, { modis_footprint: [5, 5] }, TOL);
    const judged = (id: string) => result.cells.find((c) => c.cellId === id);
    expect(judged('modis_footprint/0.0')).toMatchObject({
      stable: false,
      acceptable: false,
      unstableNeighbours: ['modis_footprint/0.1', 'modis_footprint/1.0'],
    });
    expect(judged('modis_footprint/0.1')?.stable).toBe(false);
    expect(judged('modis_footprint/1.0')?.stable).toBe(false);
    expect(judged('modis_footprint/1.1')?.stable).toBe(true);
    expect(result.selected?.cellId).toBe('modis_footprint/2.2');
    expect(result.selected?.regionCells).toBe(22);
  });

  it('checks stability against every neighbour, acceptable or not', () => {
    const scores = line(3, [0, 1]).map((s) => (s.cell.index[0] === 2 ? { ...s, f1: 0.5 } : s));
    const result = selectPlateau(scores, { modis_footprint: [3] }, TOL);
    expect(result.cells.map((c) => c.acceptable)).toEqual([true, false, false]);
  });

  it('breaks a width-and-size tie by the smallest index tuple', () => {
    const result = selectPlateau(line(7, [0, 1, 2, 4, 5, 6]), { modis_footprint: [7] }, TOL);
    expect(result.regions.map((r) => [r.cellIds.length, r.width])).toEqual([
      [3, 1],
      [3, 1],
    ]);
    expect(result.regions[0]?.cellIds[0]).toBe('modis_footprint/0');
    expect(result.selected?.index).toEqual([1]);
  });

  it('prefers the larger region at equal width, and the lower of two equidistant centres', () => {
    const result = selectPlateau(line(10, [0, 1, 2, 4, 5, 6, 7]), { modis_footprint: [10] }, TOL);
    expect(result.selected).toMatchObject({ index: [5], regionCells: 4, width: 1 });
  });

  it('prefers the wider region over the larger one', () => {
    // A 7-cell strip along the top edge (width 0) vs a 3×3 block in the middle (width 1).
    const scores = square(
      7,
      (i, j) => (i === 0 && j <= 6) || (i >= 3 && i <= 5 && j >= 3 && j <= 5),
    );
    const result = selectPlateau(scores, { modis_footprint: [7, 7] }, TOL);
    expect(result.regions.map((r) => [r.width, r.cellIds.length])).toEqual([
      [1, 9],
      [0, 7],
    ]);
    expect(result.selected?.index).toEqual([4, 4]);
  });

  it('keeps a region whose cells are all on the edge at width 0', () => {
    const result = selectPlateau(line(2, [0, 1]), { modis_footprint: [2] }, TOL);
    expect(result.selected).toMatchObject({ index: [0], width: 0, regionCells: 2 });
  });

  it('breaks a tie between slices by slice name', () => {
    const result = selectPlateau(
      [...line(3, [0, 1, 2], 'modis_footprint'), ...line(3, [0, 1, 2], 'modis_fixed')],
      { modis_footprint: [3], modis_fixed: [3] },
      TOL,
    );
    expect(result.regions.map((r) => r.slice)).toEqual(['modis_fixed', 'modis_footprint']);
    expect(result.selected?.cellId).toBe('modis_fixed/1');
  });

  it('applies both tolerances inclusively', () => {
    const run = (neighbour: Partial<Pick<CellScore, 'eventCount' | 'f1'>>) =>
      selectPlateau(
        [score('modis_footprint', [0], true), score('modis_footprint', [1], true, neighbour)],
        { modis_footprint: [2] },
        TOL,
      ).cells[0]?.stable;
    expect(run({ f1: 0.98 })).toBe(true);
    expect(run({ f1: 0.9801 })).toBe(false);
    expect(run({ eventCount: 110 })).toBe(true);
    expect(run({ eventCount: 111 })).toBe(false);
    expect(run({ eventCount: 90 })).toBe(true);
    expect(run({ f1: null })).toBe(false);
  });

  it('treats a zero-event cell as stable only against zero-event neighbours', () => {
    const zero = { eventCount: 0 };
    const stable = (other: number) =>
      selectPlateau(
        [
          score('modis_footprint', [0], true, zero),
          score('modis_footprint', [1], true, { eventCount: other }),
        ],
        { modis_footprint: [2] },
        TOL,
      ).cells[0]?.stable;
    expect(stable(0)).toBe(true);
    expect(stable(1)).toBe(false);
  });

  it('rejects a cell outside its slice and two scores for one cell', () => {
    expect(() => selectPlateau(line(3, []), { modis_footprint: [2] }, TOL)).toThrow(RangeError);
    expect(() => selectPlateau(line(3, []), {}, TOL)).toThrow(RangeError);
    expect(() =>
      selectPlateau(
        [score('modis_footprint', [0], true), score('modis_footprint', [0], true)],
        { modis_footprint: [2] },
        TOL,
      ),
    ).toThrow(RangeError);
  });
});
