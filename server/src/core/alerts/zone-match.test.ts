import { describe, expect, it } from 'vitest';

import { ZONE_GRID, indexCellKey } from '../zones/zone-geometry.js';
import {
  ZONE_MATCH_METRIC,
  candidateCellsFor,
  zoneDistanceWithin,
  zoneMatchEnvelope,
} from './zone-match.js';

const SOFIA = { lat: 42.6977, lon: 23.3219 };

/** A point `km` north of `origin` on the planar metric's latitude scale. */
function north(origin: { lat: number; lon: number }, km: number): { lat: number; lon: number } {
  return { lat: origin.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat, lon: origin.lon };
}

describe('zoneDistanceWithin', () => {
  it('returns the distance for an event inside the radius', () => {
    const km = zoneDistanceWithin(SOFIA, 10_000, north(SOFIA, 4));
    expect(km).not.toBeNull();
    expect(km).toBeCloseTo(4, 6);
  });

  it('returns null outside the radius', () => {
    expect(zoneDistanceWithin(SOFIA, 5_000, north(SOFIA, 6))).toBeNull();
  });

  it('is inclusive at the boundary', () => {
    expect(zoneDistanceWithin(SOFIA, 5_000, north(SOFIA, 5))).not.toBeNull();
  });

  it('returns zero for a centroid on the centre', () => {
    expect(zoneDistanceWithin(SOFIA, 1_000, SOFIA)).toBe(0);
  });

  it('rejects a negative or non-finite radius', () => {
    expect(() => zoneDistanceWithin(SOFIA, -1, SOFIA)).toThrow(RangeError);
    expect(() => zoneDistanceWithin(SOFIA, Number.NaN, SOFIA)).toThrow(RangeError);
  });
});

describe('candidateCellsFor', () => {
  it('includes the cell of any zone of the largest radius that could contain the event', () => {
    const event = SOFIA;
    const zoneCentre = north(SOFIA, ZONE_GRID.values.maxRadiusM / 1000 - 0.5);
    expect(zoneDistanceWithin(zoneCentre, ZONE_GRID.values.maxRadiusM, event)).not.toBeNull();
    expect(candidateCellsFor(event)).toContain(indexCellKey(zoneCentre));
  });

  it('includes the event’s own cell and is deterministic', () => {
    const cells = candidateCellsFor(SOFIA);
    expect(cells).toContain(indexCellKey(SOFIA));
    expect(candidateCellsFor(SOFIA)).toEqual(cells);
  });
});

describe('zoneMatchEnvelope', () => {
  it('contains every point the exact test accepts, on a ring at the radius', () => {
    const radiusM = 12_000;
    const box = zoneMatchEnvelope(SOFIA, radiusM);
    for (let step = 0; step < 360; step += 5) {
      const angle = (step * Math.PI) / 180;
      // Walk outwards along the bearing to the last accepted point.
      let lastInside = SOFIA;
      for (let km = 0; km <= 13; km += 0.01) {
        const kmPerLon =
          ZONE_MATCH_METRIC.kmPerDegreeLonAtReference +
          ZONE_MATCH_METRIC.kmPerDegreeLonPerDegreeLat *
            (SOFIA.lat - ZONE_MATCH_METRIC.referenceLatDeg);
        const point = {
          lat: SOFIA.lat + (km * Math.sin(angle)) / ZONE_MATCH_METRIC.kmPerDegreeLat,
          lon: SOFIA.lon + (km * Math.cos(angle)) / kmPerLon,
        };
        if (zoneDistanceWithin(SOFIA, radiusM, point) !== null) lastInside = point;
      }
      expect(lastInside.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(lastInside.lat).toBeLessThanOrEqual(box.maxLat);
      expect(lastInside.lon).toBeGreaterThanOrEqual(box.minLon);
      expect(lastInside.lon).toBeLessThanOrEqual(box.maxLon);
    }
  });

  it('is centred on the centre and rejects a bad radius', () => {
    const box = zoneMatchEnvelope(SOFIA, 5_000);
    expect((box.minLat + box.maxLat) / 2).toBeCloseTo(SOFIA.lat, 9);
    expect((box.minLon + box.maxLon) / 2).toBeCloseTo(SOFIA.lon, 9);
    expect(() => zoneMatchEnvelope(SOFIA, -1)).toThrow(RangeError);
  });
});
