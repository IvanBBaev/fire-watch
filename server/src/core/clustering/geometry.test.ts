import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from './clustering-params.js';
import {
  centroidOf,
  distanceKm,
  formatCanonicalDegrees,
  parseCanonicalDegrees,
  quantizeKm,
  withinKm,
  type Coordinate,
} from './geometry.js';

const metric = CLUSTERING_PARAMS.values.metric;

const DEG = Math.PI / 180;

/** WGS-84 arc length of one degree of latitude at φ (standard series, km). */
function trueKmPerDegreeLat(lat: number): number {
  return 111.132954 - 0.559822 * Math.cos(2 * lat * DEG) + 0.001175 * Math.cos(4 * lat * DEG);
}

/** WGS-84 arc length of one degree of longitude at φ (standard series, km). */
function trueKmPerDegreeLon(lat: number): number {
  return (
    111.41513 * Math.cos(lat * DEG) -
    0.09455 * Math.cos(3 * lat * DEG) +
    0.00012 * Math.cos(5 * lat * DEG)
  );
}

/**
 * An independent reference distance, on the true WGS-84 scales at the mean latitude.
 *
 * Deliberately *not* what the engine uses: it calls `Math.cos`, which ECMAScript specifies
 * as implementation-approximated, so two engines may legally disagree in the last bits —
 * and a distance that disagrees at exactly ε moves a detection between two events and
 * changes a `public_id` that has already been published. Good enough to measure the
 * engine's approximation against in a test; not good enough to decide identity with.
 */
function referenceKm(a: Coordinate, b: Coordinate): number {
  const meanLat = (a.lat + b.lat) / 2;
  const dx = (a.lon - b.lon) * trueKmPerDegreeLon(meanLat);
  const dy = (a.lat - b.lat) * trueKmPerDegreeLat(meanLat);
  return Math.sqrt(dx * dx + dy * dy);
}

describe('parseCanonicalDegrees', () => {
  it('accepts exactly the canonical 5-decimal form the archive stores', () => {
    expect(parseCanonicalDegrees('41.90000', 'latitude')).toBe(41.9);
    expect(parseCanonicalDegrees('-0.00001', 'longitude')).toBe(-0.00001);
  });

  it('refuses anything that is not that form', () => {
    // The text is the identity of the row — it is what the detection_uid was hashed over —
    // so a coordinate with a different number of decimals is a different row, not a
    // formatting preference.
    for (const bad of ['41.9', '41.900000', '41', ' 41.90000', '4e1.00000', '']) {
      expect(() => parseCanonicalDegrees(bad, 'latitude')).toThrow(RangeError);
    }
  });
});

describe('formatCanonicalDegrees', () => {
  it('rounds derived geometry onto the same grid the detections live on', () => {
    expect(formatCanonicalDegrees(41.9000049)).toBe('41.90000');
    expect(formatCanonicalDegrees(41.9000051)).toBe('41.90001');
  });

  it('normalises negative zero', () => {
    // `(-0.000001).toFixed(5)` is "-0.00000", which is a different string for the same
    // place — and a different string is a different byte in a checked-in fixture.
    expect(formatCanonicalDegrees(-0.000001)).toBe('0.00000');
    expect(formatCanonicalDegrees(-0)).toBe('0.00000');
  });

  it('refuses a non-finite coordinate rather than writing "NaN" into an artifact', () => {
    expect(() => formatCanonicalDegrees(Number.NaN)).toThrow(RangeError);
  });
});

describe('distanceKm', () => {
  it('is zero for a point against itself', () => {
    const point = { lat: 41.9, lon: 23.5 };
    expect(distanceKm(point, point, metric)).toBe(0);
  });

  it('is symmetric to the last bit', () => {
    // Not a nicety: the candidate scan measures d(detection, member) while a tie-break
    // compares two such distances, and an asymmetric metric would make the winner depend
    // on which argument came first.
    const a = { lat: 41.9, lon: 23.5 };
    const b = { lat: 42.1, lon: 23.9 };
    expect(distanceKm(a, b, metric)).toBe(distanceKm(b, a, metric));
  });

  it('stays within 0.2 % of the true WGS-84 scale anywhere in the polled box', () => {
    // The tangent plane is an approximation and this pins how good it has to be. 0.2 % of
    // a 1.5 km ε is 3 m; the pixel that ε describes is 375 m across. The corners of the
    // polled box (39°–46° N, 20°–31° E) are the worst case, because the longitudinal scale
    // is linearised around 42.7°.
    for (let lat = 39; lat <= 46; lat += 0.5) {
      for (const [dLat, dLon] of [
        [0.01, 0],
        [0, 0.02],
        [0.05, 0.05],
      ] as const) {
        const a: Coordinate = { lat, lon: 20 };
        const b: Coordinate = { lat: lat + dLat, lon: 20 + dLon };
        const reference = referenceKm(a, b);
        const relative = Math.abs(distanceKm(a, b, metric) - reference) / reference;
        expect(relative).toBeLessThan(0.002);
      }
    }
  });

  it('stays within 0.08 % over Bulgaria proper, where the events actually are', () => {
    for (let lat = 41; lat <= 45; lat += 0.25) {
      const a: Coordinate = { lat, lon: 25 };
      const b: Coordinate = { lat: lat + 0.02, lon: 25.03 };
      const reference = referenceKm(a, b);
      const relative = Math.abs(distanceKm(a, b, metric) - reference) / reference;
      expect(relative).toBeLessThan(0.0008);
    }
  });

  it('refuses a non-finite coordinate instead of producing a NaN distance', () => {
    // Every comparison against a NaN is false, so a NaN would not fail — it would quietly
    // stop a detection from ever matching a cluster.
    expect(() => distanceKm({ lat: Number.NaN, lon: 23 }, { lat: 41, lon: 23 }, metric)).toThrow(
      RangeError,
    );
  });
});

describe('withinKm', () => {
  it('is inclusive at exactly the bound (Appendix A rule 3)', () => {
    expect(withinKm(1.25, 1.25, metric)).toBe(true);
  });

  it('treats a distance a hair over the bound as outside', () => {
    expect(withinKm(1.25 + 2e-6, 1.25, metric)).toBe(false);
  });

  it('absorbs floating-point noise below the quantum, so "exactly ε" is reachable', () => {
    // This is the whole reason the quantum exists. Without it, a distance that differs
    // from ε by 1e-15 — which is what subtracting two nearby doubles produces — would
    // decide a cluster membership, and the pinned tie-breaks would be dead code.
    expect(withinKm(1.25 + 1e-12, 1.25, metric)).toBe(true);
  });

  it('quantises to integers, so two distances can compare exactly equal', () => {
    const left = distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.91, lon: 23.5 }, metric);
    const right = distanceKm({ lat: 41.92, lon: 23.5 }, { lat: 41.91, lon: 23.5 }, metric);
    expect(left).not.toBe(right); // the raw doubles differ …
    expect(quantizeKm(left, metric)).toBe(quantizeKm(right, metric)); // … the quanta do not
  });
});

describe('centroidOf', () => {
  it('averages onto the canonical grid', () => {
    const centroid = centroidOf([
      { lat: 41.9, lon: 23.5 },
      { lat: 41.91, lon: 23.52 },
    ]);
    expect(formatCanonicalDegrees(centroid.lat)).toBe('41.90500');
    expect(formatCanonicalDegrees(centroid.lon)).toBe('23.51000');
  });

  it('needs at least one point', () => {
    expect(() => centroidOf([])).toThrow(RangeError);
  });
});
