/**
 * The plateau rule: choose the centre of the widest acceptable region, never the argmax
 * (TASKS D7; review 11 §4.6; ADR-002 D5).
 *
 * An argmax over a noisy grid picks the luckiest cell. A config in the middle of a broad
 * region where every neighbour scores about the same is one whose numbers will survive
 * next season's data. Every word of that sentence is pinned down here, and each is a
 * founder-visible decision the fit report repeats:
 *
 * - **Neighbour**: a cell of the same slice one step away on exactly one index (±1).
 *   Slices never neighbour each other (`fit-grid.ts`).
 * - **Stable**: every existing neighbour has an event count within
 *   `eventCountTolerance` of the cell's own (relative to the cell, inclusive) *and* a
 *   pooled pairwise F1 within `f1Tolerance` (absolute, inclusive). An unmeasured F1 on
 *   either side is unstable. A cell with zero events is stable only against neighbours
 *   with zero events.
 * - **Acceptable**: meets every GATES §2 target (`verdictOf`) *and* is stable.
 * - **Region**: a connected component of acceptable cells under the neighbour relation.
 * - **Inradius** of an acceptable cell: the largest r ≥ 0 such that every cell within
 *   L∞ distance r on the slice's indices exists on the grid and is acceptable — the
 *   biggest all-acceptable box centred on it. A cell on the grid edge has inradius 0: the
 *   grid edge is where evidence stops, not where the plateau does.
 * - **Width** of a region: the largest inradius among its cells.
 * - **Widest region**: greatest width; ties by more cells; then by slice name; then by the
 *   lexicographically smallest index tuple in it. Deterministic, never random.
 * - **Centre**: among the region's cells whose inradius equals its width, the one closest
 *   (squared Euclidean, on indices) to the region's index centroid; ties by the
 *   lexicographically smallest index tuple.
 * - **No acceptable cell**: no selection. The fit then writes no candidate, and the report
 *   says so — there is no "least bad" fallback.
 */

import type { GridCell, GridSlice } from './fit-grid.js';

export interface PlateauTolerances {
  readonly eventCountTolerance: number;
  readonly f1Tolerance: number;
}

export interface CellScore {
  readonly cell: GridCell;
  readonly eventCount: number;
  readonly f1: number | null;
  /** Meets every gate target (pooled and bottom stratum). */
  readonly meetsTargets: boolean;
}

export interface CellJudgement {
  readonly cellId: string;
  readonly meetsTargets: boolean;
  readonly stable: boolean;
  readonly acceptable: boolean;
  /** Neighbour ids that broke stability, sorted. */
  readonly unstableNeighbours: readonly string[];
  /** `null` when not acceptable. */
  readonly inradius: number | null;
}

export interface PlateauRegion {
  readonly slice: GridSlice;
  readonly cellIds: readonly string[];
  readonly width: number;
}

export interface PlateauSelection {
  readonly cellId: string;
  readonly slice: GridSlice;
  readonly index: readonly number[];
  readonly regionCells: number;
  readonly width: number;
}

export interface PlateauResult {
  readonly cells: readonly CellJudgement[];
  /** Widest first, in the selection order. */
  readonly regions: readonly PlateauRegion[];
  readonly selected: PlateauSelection | null;
}

const EPS = 1e-9;

/**
 * @param shapes the dimension sizes per slice (`sliceShape`); a cell index outside its
 *   slice's shape, or two scores on one cell, is an error.
 */
export function selectPlateau(
  scores: readonly CellScore[],
  shapes: Readonly<Partial<Record<GridSlice, readonly number[]>>>,
  tolerances: PlateauTolerances,
): PlateauResult {
  const key = (slice: string, index: readonly number[]): string => `${slice}@${index.join(',')}`;
  const byPos = new Map<string, CellScore>();
  for (const score of scores) {
    const shape = shapes[score.cell.slice];
    if (
      shape === undefined ||
      shape.length !== score.cell.index.length ||
      score.cell.index.some((v, d) => !Number.isInteger(v) || v < 0 || v >= (shape[d] as number))
    ) {
      throw new RangeError(`plateau: cell ${score.cell.id} lies outside its slice`);
    }
    const k = key(score.cell.slice, score.cell.index);
    if (byPos.has(k)) throw new RangeError(`plateau: two scores for ${k}`);
    byPos.set(k, score);
  }

  const neighbours = (score: CellScore): CellScore[] => {
    const out: CellScore[] = [];
    score.cell.index.forEach((_, d) => {
      for (const step of [-1, 1]) {
        const index = score.cell.index.map((v, e) => (e === d ? v + step : v));
        const n = byPos.get(key(score.cell.slice, index));
        if (n !== undefined) out.push(n);
      }
    });
    return out;
  };

  const stableAgainst = (c: CellScore, n: CellScore): boolean => {
    const countOk =
      c.eventCount === 0
        ? n.eventCount === 0
        : Math.abs(n.eventCount - c.eventCount) <=
          tolerances.eventCountTolerance * c.eventCount + EPS;
    const f1Ok =
      c.f1 !== null && n.f1 !== null && Math.abs(n.f1 - c.f1) <= tolerances.f1Tolerance + EPS;
    return countOk && f1Ok;
  };

  const acceptable = new Set<string>();
  const unstable = new Map<string, string[]>();
  for (const score of scores) {
    const broke = neighbours(score)
      .filter((n) => !stableAgainst(score, n))
      .map((n) => n.cell.id)
      .sort();
    unstable.set(score.cell.id, broke);
    if (score.meetsTargets && broke.length === 0) {
      acceptable.add(key(score.cell.slice, score.cell.index));
    }
  }

  const inradiusOf = (score: CellScore): number => {
    const shape = shapes[score.cell.slice] as readonly number[];
    let r = 0;
    for (;;) {
      const next = r + 1;
      const inGrid = score.cell.index.every(
        (v, d) => v - next >= 0 && v + next < (shape[d] as number),
      );
      if (!inGrid || !boxAcceptable(score, next)) return r;
      r = next;
    }
  };
  const boxAcceptable = (score: CellScore, r: number): boolean => {
    let ok = true;
    forEachInBox(score.cell.index, r, (index) => {
      if (ok && !acceptable.has(key(score.cell.slice, index))) ok = false;
    });
    return ok;
  };

  const inradius = new Map<string, number>();
  for (const score of scores) {
    const k = key(score.cell.slice, score.cell.index);
    if (acceptable.has(k)) inradius.set(k, inradiusOf(score));
  }

  // Connected components, scanning in input order for determinism.
  const seen = new Set<string>();
  const components: CellScore[][] = [];
  for (const score of scores) {
    const start = key(score.cell.slice, score.cell.index);
    if (!acceptable.has(start) || seen.has(start)) continue;
    const members: CellScore[] = [];
    const queue = [score];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift() as CellScore;
      members.push(current);
      for (const n of neighbours(current)) {
        const k = key(n.cell.slice, n.cell.index);
        if (acceptable.has(k) && !seen.has(k)) {
          seen.add(k);
          queue.push(n);
        }
      }
    }
    members.sort((x, y) => compareIndex(x.cell.index, y.cell.index));
    components.push(members);
  }

  const widthOf = (members: readonly CellScore[]): number =>
    Math.max(...members.map((m) => inradius.get(key(m.cell.slice, m.cell.index)) as number));
  const ranked = components
    .map((members) => ({ members, width: widthOf(members) }))
    .sort(
      (x, y) =>
        y.width - x.width ||
        y.members.length - x.members.length ||
        compareText(
          (x.members[0] as CellScore).cell.slice,
          (y.members[0] as CellScore).cell.slice,
        ) ||
        compareIndex(
          (x.members[0] as CellScore).cell.index,
          (y.members[0] as CellScore).cell.index,
        ),
    );

  let selected: PlateauSelection | null = null;
  const best = ranked[0];
  if (best !== undefined) {
    const n = best.members.length;
    const dims = (best.members[0] as CellScore).cell.index.length;
    const sums = Array.from({ length: dims }, (_, d) =>
      best.members.reduce((acc, m) => acc + (m.cell.index[d] as number), 0),
    );
    // Squared distance to the centroid, scaled by n² so it stays an exact integer.
    const distance = (index: readonly number[]): number =>
      index.reduce((acc, v, d) => acc + (n * v - (sums[d] as number)) ** 2, 0);
    const centre = best.members
      .filter((m) => inradius.get(key(m.cell.slice, m.cell.index)) === best.width)
      .sort(
        (x, y) =>
          distance(x.cell.index) - distance(y.cell.index) ||
          compareIndex(x.cell.index, y.cell.index),
      )[0] as CellScore;
    selected = {
      cellId: centre.cell.id,
      slice: centre.cell.slice,
      index: centre.cell.index,
      regionCells: n,
      width: best.width,
    };
  }

  return {
    cells: scores.map((score) => {
      const k = key(score.cell.slice, score.cell.index);
      const broke = unstable.get(score.cell.id) as string[];
      return {
        cellId: score.cell.id,
        meetsTargets: score.meetsTargets,
        stable: broke.length === 0,
        acceptable: acceptable.has(k),
        unstableNeighbours: broke,
        inradius: inradius.get(k) ?? null,
      };
    }),
    regions: ranked.map(({ members, width }) => ({
      slice: (members[0] as CellScore).cell.slice,
      cellIds: members.map((m) => m.cell.id),
      width,
    })),
    selected,
  };
}

function forEachInBox(
  centre: readonly number[],
  r: number,
  visit: (index: readonly number[]) => void,
): void {
  const index = centre.map((v) => v - r);
  for (;;) {
    visit(index);
    let d = index.length - 1;
    while (d >= 0 && (index[d] as number) === (centre[d] as number) + r) {
      index[d] = (centre[d] as number) - r;
      d -= 1;
    }
    if (d < 0) return;
    index[d] = (index[d] as number) + 1;
  }
}

function compareIndex(a: readonly number[], b: readonly number[]): number {
  for (let d = 0; d < Math.min(a.length, b.length); d += 1) {
    const diff = (a[d] as number) - (b[d] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
