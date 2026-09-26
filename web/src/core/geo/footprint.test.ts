import { describe, expect, it } from 'vitest';

import {
  NADIR_SCAN_KM,
  NADIR_TRACK_KM,
  footprintBounds,
  footprintRing,
  resolveFootprintKm,
} from './footprint.js';

describe('the pinned nadir footprint', () => {
  // Transcribed from server/src/core/ingest/detection-validation.ts, which the web package
  // cannot import. If the ingest side ever repins these, this test is the tripwire.
  it('matches the ingest-side substitution', () => {
    expect(NADIR_SCAN_KM).toBe(1.0);
    expect(NADIR_TRACK_KM).toBe(2.0);
  });
});

describe('resolveFootprintKm', () => {
  it('keeps a usable pair', () => {
    expect(resolveFootprintKm(0.375, 0.375)).toEqual({ scanKm: 0.375, trackKm: 0.375 });
  });

  it.each([
    ['both missing', null, null],
    ['scan missing', null, 0.375],
    ['track missing', 0.375, null],
    ['zero', 0, 0.375],
    ['negative', -1, 0.375],
    ['non-finite', Number.NaN, 0.375],
    ['beyond the plausible envelope', 42, 0.375],
  ])('substitutes the nadir pair when %s', (_case, scan, track) => {
    expect(resolveFootprintKm(scan, track)).toEqual({
      scanKm: NADIR_SCAN_KM,
      trackKm: NADIR_TRACK_KM,
    });
  });

  it('replaces the pair rather than the broken axis, so no invented aspect ratio survives', () => {
    // A real 4.8 km scan with a missing track must not become 4.8 × 2.0.
    expect(resolveFootprintKm(4.8, null)).toEqual({
      scanKm: NADIR_SCAN_KM,
      trackKm: NADIR_TRACK_KM,
    });
  });
});

describe('footprintBounds', () => {
  it('centres the cell on the pixel centre', () => {
    const bounds = footprintBounds(25.9, 41.93, { scanKm: 0.375, trackKm: 0.375 });
    expect((bounds.west + bounds.east) / 2).toBeCloseTo(25.9, 9);
    expect((bounds.south + bounds.north) / 2).toBeCloseTo(41.93, 9);
  });

  it('gives the track extent its full height in degrees of latitude', () => {
    const bounds = footprintBounds(25.9, 41.93, { scanKm: 1, trackKm: 2 });
    expect((bounds.north - bounds.south) * 111.32).toBeCloseTo(2, 6);
  });

  it('widens longitudinally with latitude, because a degree of longitude shortens', () => {
    const footprint = { scanKm: 1, trackKm: 1 };
    const south = footprintBounds(25, 35, footprint);
    const north = footprintBounds(25, 55, footprint);
    expect(north.east - north.west).toBeGreaterThan(south.east - south.west);
  });

  it('stays finite at the pole, where cos(lat) reaches zero', () => {
    const bounds = footprintBounds(25, 90, { scanKm: 1, trackKm: 1 });
    expect(Number.isFinite(bounds.west)).toBe(true);
    expect(Number.isFinite(bounds.east)).toBe(true);
  });
});

describe('footprintRing', () => {
  const ring = footprintRing(25.9, 41.93, { scanKm: 0.375, trackKm: 0.375 });

  it('closes the ring', () => {
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it('winds counter-clockwise, as RFC 7946 asks of an exterior ring', () => {
    // Shoelace: a positive signed area is counter-clockwise.
    let twiceArea = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i] as readonly [number, number];
      const [x2, y2] = ring[i + 1] as readonly [number, number];
      twiceArea += x1 * y2 - x2 * y1;
    }
    expect(twiceArea).toBeGreaterThan(0);
  });

  it('agrees with the bounds it is built from', () => {
    const bounds = footprintBounds(25.9, 41.93, { scanKm: 0.375, trackKm: 0.375 });
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    expect(Math.min(...lons)).toBeCloseTo(bounds.west, 12);
    expect(Math.max(...lons)).toBeCloseTo(bounds.east, 12);
    expect(Math.min(...lats)).toBeCloseTo(bounds.south, 12);
    expect(Math.max(...lats)).toBeCloseTo(bounds.north, 12);
  });
});
