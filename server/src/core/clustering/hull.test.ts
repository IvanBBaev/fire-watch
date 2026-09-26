import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from './clustering-params.js';
import { distanceKm, quantizeKm, type Coordinate } from './geometry.js';
import { convexHull, exceedsReviewDiameter, hullDiameterKm } from './hull.js';

const PARAMS = CLUSTERING_PARAMS.values;
const METRIC = PARAMS.metric;

function point(lon: number, lat: number): Coordinate {
  return { lat, lon };
}

/** The definition the fast path has to agree with: every pair, no hull involved. */
function bruteForceDiameterKm(points: readonly Coordinate[]): number {
  let widest = 0;
  for (const a of points) {
    for (const b of points) {
      const km = distanceKm(a, b, METRIC);
      if (km > widest) widest = km;
    }
  }
  return widest;
}

describe('convexHull', () => {
  it('returns a single point as its own hull', () => {
    expect(convexHull([point(23.5, 41.9)])).toEqual([point(23.5, 41.9)]);
  });

  it('returns two points as a segment', () => {
    expect(convexHull([point(24, 42), point(23.5, 41.9)])).toEqual([
      point(23.5, 41.9),
      point(24, 42),
    ]);
  });

  it('drops points strictly inside the hull', () => {
    const square = [point(23, 41), point(24, 41), point(24, 42), point(23, 42)];
    const inside = point(23.5, 41.5);
    expect(convexHull([...square, inside])).toHaveLength(4);
    expect(convexHull([...square, inside])).not.toContainEqual(inside);
  });

  it('starts at the lexicographically smallest vertex and winds counter-clockwise', () => {
    // A fixed start and a fixed winding make the hull a value a replay can compare, rather
    // than a set the comparison has to normalise first.
    const square = [point(24, 42), point(23, 42), point(24, 41), point(23, 41)];
    expect(convexHull(square)).toEqual([
      point(23, 41),
      point(24, 41),
      point(24, 42),
      point(23, 42),
    ]);
  });

  it('collapses a collinear set to its two ends', () => {
    // A straight fire front sampled densely is still a segment. Keeping the interior
    // samples would make the vertex list depend on the instrument's sampling rate.
    const line = [point(23, 41), point(23.25, 41), point(23.5, 41), point(23.75, 41)];
    expect(convexHull(line)).toEqual([point(23, 41), point(23.75, 41)]);
  });

  it('collapses exact duplicates', () => {
    // The normal case, not an edge case: a stationary fire is re-detected at the same pixel
    // pass after pass, so most of a cluster's members share a coordinate.
    const repeated = [point(23, 41), point(23, 41), point(23, 41), point(24, 42)];
    expect(convexHull(repeated)).toEqual([point(23, 41), point(24, 42)]);
  });

  it('is insensitive to input order', () => {
    const points = [
      point(23.1, 41.2),
      point(23.9, 41.1),
      point(24.0, 41.8),
      point(23.4, 41.9),
      point(23.6, 41.5),
    ];
    const forward = convexHull(points);
    const backward = convexHull([...points].reverse());
    expect(backward).toEqual(forward);
  });

  it('rejects a non-finite coordinate rather than producing a hull around it', () => {
    expect(() => convexHull([point(23, 41), point(Number.NaN, 41)])).toThrow(RangeError);
  });
});

describe('hullDiameterKm', () => {
  it('is zero for a single point — no extent, not unknown extent', () => {
    expect(hullDiameterKm([point(23.5, 41.9)], METRIC)).toBe(0);
  });

  it('needs at least one point', () => {
    expect(() => hullDiameterKm([], METRIC)).toThrow(RangeError);
  });

  it('equals the brute-force maximum over every pair', () => {
    // The whole argument for hulling first is that it is exact, not an approximation: the
    // diameter of a set is always realised by two extreme points.
    const points = [
      point(23.1, 41.2),
      point(23.9, 41.1),
      point(24.0, 41.8),
      point(23.4, 41.9),
      point(23.6, 41.5),
      point(23.55, 41.45),
      point(23.7, 41.3),
    ];
    expect(hullDiameterKm(points, METRIC)).toBe(bruteForceDiameterKm(points));
  });

  it('still equals the brute-force maximum when the widest pair straddles an interior point', () => {
    const points = [point(23, 41), point(23.5, 41.5), point(24, 42), point(23.2, 41.9)];
    expect(hullDiameterKm(points, METRIC)).toBe(bruteForceDiameterKm(points));
  });

  it('measures a pure north-south pair at the latitude scale of the metric', () => {
    const km = hullDiameterKm([point(23.5, 41.9), point(23.5, 42.1)], METRIC);
    expect(km).toBeCloseTo(0.2 * METRIC.kmPerDegreeLat, 9);
  });
});

describe('exceedsReviewDiameter — ADR-002 D4', () => {
  it('leaves an event of exactly the threshold inside it', () => {
    // Appendix A rule 3. Two identical fires, one flagged and one not, because a square
    // root landed a millimetre either side of 20 km, is an arbitrary difference presented
    // to a reviewer as a judgement.
    expect(exceedsReviewDiameter(PARAMS.reviewHullDiameterKm, PARAMS)).toBe(false);
  });

  it('ignores residue below half a quantum', () => {
    expect(exceedsReviewDiameter(PARAMS.reviewHullDiameterKm + 4e-7, PARAMS)).toBe(false);
  });

  it('flags an event a full quantum over the threshold', () => {
    expect(exceedsReviewDiameter(PARAMS.reviewHullDiameterKm + 1e-6, PARAMS)).toBe(true);
    expect(quantizeKm(PARAMS.reviewHullDiameterKm + 1e-6, METRIC)).toBeGreaterThan(
      quantizeKm(PARAMS.reviewHullDiameterKm, METRIC),
    );
  });

  it('does not flag a fire that is merely large', () => {
    // ~16.7 km across: a serious fire, and still one fire. The flag means "this may be two
    // events", not "this is big".
    const km = hullDiameterKm([point(23.5, 41.9), point(23.5, 42.05)], METRIC);
    expect(km).toBeGreaterThan(16);
    expect(exceedsReviewDiameter(km, PARAMS)).toBe(false);
  });

  it('flags a hull that has grown past the threshold', () => {
    const km = hullDiameterKm([point(23.5, 41.9), point(23.5, 42.1)], METRIC);
    expect(km).toBeGreaterThan(PARAMS.reviewHullDiameterKm);
    expect(exceedsReviewDiameter(km, PARAMS)).toBe(true);
  });
});
