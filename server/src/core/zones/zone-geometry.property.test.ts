/**
 * I2 — what is stored is coarsened (ADR-004 D8, A1.10).
 *
 * Stated as properties because the failures that matter live at cell edges and at the
 * envelope's corners, which a handful of hand-picked villages would never visit. The
 * headline is the first block: a coarsened centre is a *function of its cell*, so two
 * clicks anywhere in one ~1 km cell store the same bytes, and nothing finer than the cell
 * survives into the row.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { alertableEnvelope } from '../config/polling-bbox.js';
import {
  assertRadiusM,
  coarsenCentre,
  indexCellKey,
  indexCellsWithin,
  maxCoarseningErrorKm,
  prepareCentre,
  ZONE_GRID,
} from './zone-geometry.js';

const ENVELOPE = alertableEnvelope();
const PARAMS = ZONE_GRID.values;

/** Any point inside the alertable area — the only points a zone can have. */
const point = fc.record({
  lat: fc.double({ min: ENVELOPE.south, max: ENVELOPE.north, noNaN: true }),
  lon: fc.double({ min: ENVELOPE.west, max: ENVELOPE.east, noNaN: true }),
});

/** Planar km on the same approximation the grid is described in; test-side only. */
function approxKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const kmLat = (a.lat - b.lat) * 111.32;
  const kmLon = (a.lon - b.lon) * 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.sqrt(kmLat * kmLat + kmLon * kmLon);
}

describe('coarsening', () => {
  it('is idempotent, so a zone re-saved unchanged does not drift', () => {
    fc.assert(
      fc.property(point, (p) => {
        const once = coarsenCentre(p);
        expect(coarsenCentre(once)).toEqual(once);
      }),
    );
  });

  it('forgets everything finer than the cell: every click in one cell stores one centre', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        (p, fracLat, fracLon) => {
          const step = 1 / PARAMS.coarseCellsPerDegree;
          const cellLat = Math.floor(p.lat * PARAMS.coarseCellsPerDegree);
          const cellLon = Math.floor(p.lon * PARAMS.coarseCellsPerDegree);
          const sibling = {
            lat: (cellLat + fracLat) * step,
            lon: (cellLon + fracLon) * step,
          };
          // Rebuilding a point from (index + fraction) × step can land one ulp outside the
          // cell; that is float arithmetic in the *test*, not the snap, so skip it.
          fc.pre(
            Math.floor(sibling.lat * PARAMS.coarseCellsPerDegree) === cellLat &&
              Math.floor(sibling.lon * PARAMS.coarseCellsPerDegree) === cellLon,
          );
          expect(coarsenCentre(sibling)).toEqual(coarsenCentre(p));
        },
      ),
    );
  });

  it('stores only centres that lie on the grid', () => {
    fc.assert(
      fc.property(point, (p) => {
        const { lat, lon } = coarsenCentre(p);
        // (index + ½) / 100 — so ×100 − ½ is an integer to within rounding of the division.
        const latSteps = lat * PARAMS.coarseCellsPerDegree - 0.5;
        const lonSteps = lon * PARAMS.coarseCellsPerDegree - 0.5;
        expect(Math.abs(latSteps - Math.round(latSteps))).toBeLessThan(1e-6);
        expect(Math.abs(lonSteps - Math.round(lonSteps))).toBeLessThan(1e-6);
      }),
    );
  });

  it('moves a centre by at most half the cell diagonal', () => {
    fc.assert(
      fc.property(point, (p) => {
        expect(approxKm(p, coarsenCentre(p))).toBeLessThanOrEqual(
          maxCoarseningErrorKm(ENVELOPE.south) + 1e-9,
        );
      }),
    );
  });

  it('keeps A1.10 honest: the worst displacement is well under the minimum radius', () => {
    // "Coarsening error ≪ radius" as a number: under 0.75 km — less than 40 % of the 2 km
    // floor — at the southern edge of the envelope, where east–west cells are widest. The
    // floor's own 2 km is A1.10's; the 40 % is this test's reading of "≪", not a spec value.
    expect(maxCoarseningErrorKm(ENVELOPE.south)).toBeLessThan(0.75);
    expect(maxCoarseningErrorKm(ENVELOPE.south) / (PARAMS.minRadiusM / 1000)).toBeLessThan(0.4);
  });

  it('is a step function of the input and nothing else', () => {
    expect(coarsenCentre({ lat: 42.69751, lon: 23.32415 })).toEqual({ lat: 42.695, lon: 23.325 });
    expect(coarsenCentre({ lat: 42.69001, lon: 23.32999 })).toEqual({ lat: 42.695, lon: 23.325 });
  });
});

describe('the index cell', () => {
  it('nests the coarse grid, so coarsening never changes which index cell a zone is in', () => {
    fc.assert(
      fc.property(point, (p) => {
        expect(indexCellKey(coarsenCentre(p))).toBe(indexCellKey(p));
      }),
    );
  });

  it('is coarser than the centre: a ~5 km cell holds many coarsened centres', () => {
    const ratio = PARAMS.coarseCellsPerDegree / PARAMS.indexCellsPerDegree;
    expect(Number.isInteger(ratio)).toBe(true);
    expect(ratio).toBeGreaterThanOrEqual(5);
  });

  it('finds every zone whose circle can reach a point', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (fire, bearing, fraction) => {
          // A zone centre anywhere within the maximum radius of the fire.
          const km = (fraction * PARAMS.maxRadiusM) / 1000;
          const centre = {
            lat: fire.lat + (km * Math.cos(bearing)) / 111.32,
            lon:
              fire.lon + (km * Math.sin(bearing)) / (111.32 * Math.cos((fire.lat * Math.PI) / 180)),
          };
          expect(indexCellsWithin(fire, PARAMS.maxRadiusM)).toContain(indexCellKey(centre));
        },
      ),
    );
  });

  it('stays a small candidate set at the maximum radius', () => {
    // ±30 km is ±0.27° lat and ±0.37° lon at 42°N: ~13 × ~17 cells with the slack.
    expect(indexCellsWithin({ lat: 42.7, lon: 23.3 }, PARAMS.maxRadiusM).length).toBeLessThan(300);
  });
});

describe('preparing a centre', () => {
  it('stores the coarsened centre when the toggle is on, and says so', () => {
    fc.assert(
      fc.property(point, (p) => {
        const prepared = prepareCentre(p, { coarsen: true });
        expect(prepared.stored).toEqual(coarsenCentre(p));
        expect(prepared.coarsened).toBe(true);
        expect(prepared.gridVersion).toBe('zone_grid_v1');
        expect(prepared.indexCell).toBe(indexCellKey(p));
      }),
    );
  });

  it('stores the click itself only when the user turned coarsening off', () => {
    const click = { lat: 42.69751, lon: 23.32415 };
    const prepared = prepareCentre(click, { coarsen: false });
    expect(prepared.stored).toEqual(click);
    expect(prepared.coarsened).toBe(false);
  });

  it('refuses a centre outside Bulgaria + 100 km, where no zone can ever alert', () => {
    expect(() => prepareCentre({ lat: 48.85, lon: 2.35 }, { coarsen: true })).toThrow(
      /outside the alertable area/,
    );
  });

  it('refuses non-numbers without quoting them', () => {
    for (const bad of [
      { lat: Number.NaN, lon: 23 },
      { lat: 42, lon: Number.POSITIVE_INFINITY },
      { lat: 91, lon: 23 },
    ]) {
      expect(() => prepareCentre(bad, { coarsen: true })).toThrow(/^zone (latitude|longitude)/);
    }
  });

  it('never puts a coordinate into an error message', () => {
    // 05 §5.3.2: no coordinates in logs. Error text is what reaches a log line.
    try {
      prepareCentre({ lat: 48.85123, lon: 2.35123 }, { coarsen: true });
    } catch (error) {
      expect(String(error)).not.toMatch(/48\.8|2\.35/);
    }
  });
});

describe('the radius rule (A1.10)', () => {
  it('accepts the whole 2–30 km slider, default included', () => {
    for (const radius of [PARAMS.minRadiusM, PARAMS.defaultRadiusM, PARAMS.maxRadiusM]) {
      expect(() => assertRadiusM(radius)).not.toThrow();
    }
  });

  it('refuses anything under 2 km, whatever the coarsening toggle says', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: PARAMS.minRadiusM - 1 }), (radius) => {
        expect(() => assertRadiusM(radius)).toThrow(/must lie within/);
      }),
    );
  });

  it('refuses a radius the polling-bbox buffer was not sized for', () => {
    expect(() => assertRadiusM(PARAMS.maxRadiusM + 1)).toThrow(/must lie within/);
  });

  it('refuses fractional metres rather than letting the integer column round them', () => {
    expect(() => assertRadiusM(2000.5)).toThrow(/whole metres/);
  });
});
