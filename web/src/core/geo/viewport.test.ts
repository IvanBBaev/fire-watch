import { describe, expect, it } from 'vitest';

import type { GeoBounds } from './viewport.js';
import { boundsContain, expandBoundsKm } from './viewport.js';

const SOFIA_BOX: GeoBounds = { west: 23.0, south: 42.5, east: 23.6, north: 42.9 };

describe('boundsContain', () => {
  it('accepts a point inside and rejects one outside', () => {
    expect(boundsContain(SOFIA_BOX, 23.32, 42.7)).toBe(true);
    expect(boundsContain(SOFIA_BOX, 25.0, 42.7)).toBe(false);
    expect(boundsContain(SOFIA_BOX, 23.32, 41.0)).toBe(false);
  });

  it('treats the edges as inside, so a fire on the frame line is not dropped', () => {
    expect(boundsContain(SOFIA_BOX, 23.0, 42.5)).toBe(true);
    expect(boundsContain(SOFIA_BOX, 23.6, 42.9)).toBe(true);
  });

  it('handles a viewport wrapped across the antimeridian', () => {
    const wrapped: GeoBounds = { west: 170, south: -10, east: -170, north: 10 };
    expect(boundsContain(wrapped, 179, 0)).toBe(true);
    expect(boundsContain(wrapped, -179, 0)).toBe(true);
    expect(boundsContain(wrapped, 0, 0)).toBe(false);
  });

  it('rejects non-finite coordinates instead of letting NaN answer true', () => {
    expect(boundsContain(SOFIA_BOX, Number.NaN, 42.7)).toBe(false);
    expect(boundsContain(SOFIA_BOX, 23.32, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('expandBoundsKm', () => {
  it('grows latitude by the plain meridian conversion', () => {
    const grown = expandBoundsKm(SOFIA_BOX, 111.32);
    expect(grown.south).toBeCloseTo(41.5, 6);
    expect(grown.north).toBeCloseTo(43.9, 6);
  });

  it('grows longitude by more than latitude, because a lon degree is shorter here', () => {
    const grown = expandBoundsKm(SOFIA_BOX, 100);
    const lonGrowth = SOFIA_BOX.west - grown.west;
    const latGrowth = SOFIA_BOX.south - grown.south;
    expect(lonGrowth).toBeGreaterThan(latGrowth);
    expect(grown.east - SOFIA_BOX.east).toBeCloseTo(lonGrowth, 12);
  });

  it('measures the lon degree at the pole-most edge of the result, not the input', () => {
    // Widening at 42.9° (the input's north) would understate the band; the result's
    // north is 43.8°, where a degree of longitude is shorter and the band therefore wider.
    const km = 100;
    const grown = expandBoundsKm(SOFIA_BOX, km);
    const atInputEdge = km / (111.32 * Math.cos((SOFIA_BOX.north * Math.PI) / 180));
    expect(SOFIA_BOX.west - grown.west).toBeGreaterThan(atInputEdge);
  });

  it('stays finite next to the pole instead of dividing by cos(90°)', () => {
    const polar = expandBoundsKm({ west: 10, south: 88, east: 20, north: 89.5 }, 100);
    expect(Number.isFinite(polar.west)).toBe(true);
    expect(Number.isFinite(polar.east)).toBe(true);
  });

  it('is a no-op at zero kilometres', () => {
    expect(expandBoundsKm(SOFIA_BOX, 0)).toEqual(SOFIA_BOX);
  });
});
