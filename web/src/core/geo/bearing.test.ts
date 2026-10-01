import { describe, expect, it } from 'vitest';

import { compassPoint, distanceKm, initialBearingDegrees, relativePosition } from './bearing.js';

const SOFIA = { lon: 23.3219, lat: 42.6977 };
const PLOVDIV = { lon: 24.7453, lat: 42.1354 };

describe('distanceKm', () => {
  it('is zero for the same point', () => {
    expect(distanceKm(SOFIA, SOFIA)).toBe(0);
  });

  it('matches the known Sofia–Plovdiv great-circle distance (~131 km)', () => {
    expect(distanceKm(SOFIA, PLOVDIV)).toBeGreaterThan(129);
    expect(distanceKm(SOFIA, PLOVDIV)).toBeLessThan(133);
  });

  it('is symmetric', () => {
    expect(distanceKm(SOFIA, PLOVDIV)).toBeCloseTo(distanceKm(PLOVDIV, SOFIA), 9);
  });

  it('gives ~111 km for one degree of latitude', () => {
    expect(distanceKm({ lon: 25, lat: 42 }, { lon: 25, lat: 43 })).toBeCloseTo(111.2, 0);
  });
});

describe('initialBearingDegrees', () => {
  it('is 0 due north and 180 due south', () => {
    expect(initialBearingDegrees({ lon: 25, lat: 42 }, { lon: 25, lat: 43 })).toBeCloseTo(0, 6);
    expect(initialBearingDegrees({ lon: 25, lat: 43 }, { lon: 25, lat: 42 })).toBeCloseTo(180, 6);
  });

  it('is ~90 due east and ~270 due west', () => {
    expect(initialBearingDegrees({ lon: 25, lat: 42 }, { lon: 25.1, lat: 42 })).toBeCloseTo(90, 0);
    expect(initialBearingDegrees({ lon: 25.1, lat: 42 }, { lon: 25, lat: 42 })).toBeCloseTo(270, 0);
  });

  it('puts Plovdiv south-east of Sofia', () => {
    const bearing = initialBearingDegrees(SOFIA, PLOVDIV);
    expect(bearing).toBeGreaterThan(112.5);
    expect(bearing).toBeLessThan(157.5);
  });
});

describe('compassPoint', () => {
  it.each([
    [0, 'N'],
    [22.4, 'N'],
    [22.6, 'NE'],
    [90, 'E'],
    [135, 'SE'],
    [180, 'S'],
    [225, 'SW'],
    [270, 'W'],
    [315, 'NW'],
    [337.6, 'N'],
    [359.9, 'N'],
    [-45, 'NW'],
    [720, 'N'],
  ] as const)('%s° → %s', (degrees, expected) => {
    expect(compassPoint(degrees)).toBe(expected);
  });
});

describe('relativePosition', () => {
  it('rounds to whole km at 10 km and beyond', () => {
    const position = relativePosition(SOFIA, PLOVDIV);
    expect(Number.isInteger(position.km)).toBe(true);
    expect(position.compass).toBe('SE');
    expect(position.nearby).toBe(false);
  });

  it('keeps one decimal under 10 km', () => {
    const position = relativePosition({ lon: 25, lat: 42 }, { lon: 25, lat: 42.05 });
    expect(position.km).toBe(5.6);
    expect(position.compass).toBe('N');
  });

  it('flags a target under 1 km as nearby and never reports 0 km', () => {
    const position = relativePosition({ lon: 25, lat: 42 }, { lon: 25, lat: 42 });
    expect(position.nearby).toBe(true);
    expect(position.km).toBe(0.1);
  });
});
