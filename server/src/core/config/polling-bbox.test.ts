import { describe, expect, it } from 'vitest';

import {
  ALERTABLE_BUFFER_KM,
  BULGARIA_ENVELOPE,
  MIN_BBOX_BUFFER_KM,
  POLLING_BBOX,
  alertableEnvelope,
  assertBboxCovers,
  assertBoundingBox,
  bboxBufferKm,
  expandBboxKm,
  firmsAreaArgument,
  type BoundingBox,
} from './polling-bbox.js';

describe('polling_bbox_v1', () => {
  it('is the value DATA-SOURCES §A9 pins', () => {
    expect(POLLING_BBOX.name).toBe('polling_bbox');
    expect(POLLING_BBOX.version).toBe('polling_bbox_v1');
    expect(POLLING_BBOX.values).toEqual({ west: 20.0, south: 39.0, east: 31.0, north: 46.0 });
  });

  it('covers the alertable area with the required buffer on every edge', () => {
    // This is §A9's rule, executed. It is what fails the build the day someone widens the
    // alertable area, retunes ε_max, or raises the watch-zone radius slider without
    // widening the poll — the failure mode where E accrues on data nobody ever queried.
    expect(() => assertBboxCovers(POLLING_BBOX.values, alertableEnvelope())).not.toThrow();
  });

  it('keeps more than twice the minimum margin, so a retune is not immediately a bump', () => {
    const margin = bboxBufferKm(POLLING_BBOX.values, alertableEnvelope());

    for (const km of Object.values(margin)) {
      expect(km).toBeGreaterThan(2 * MIN_BBOX_BUFFER_KM);
    }
  });

  it('states the buffer as 2 × ε_max + the largest watch-zone radius', () => {
    expect(MIN_BBOX_BUFFER_KM).toBe(2 * 6 + 30);
  });
});

describe('firmsAreaArgument', () => {
  it('emits west,south,east,north — the FIRMS order, not the printed-bbox order', () => {
    expect(firmsAreaArgument()).toBe('20,39,31,46');
  });

  it('renders a fractional edge as plain decimal text', () => {
    expect(firmsAreaArgument({ west: 20.5, south: 39.25, east: 31.125, north: 46.0 })).toBe(
      '20.5,39.25,31.125,46',
    );
  });

  it('never emits exponent notation', () => {
    // `String(1e-7)` is "1e-7", which no API parses as a coordinate.
    expect(firmsAreaArgument({ west: -1e-7, south: 1e-7, east: 1, north: 2 })).toBe('0,0,1,2');
  });

  it('refuses a box it cannot query', () => {
    expect(() => firmsAreaArgument({ west: 31, south: 39, east: 20, north: 46 })).toThrow(
      /strictly west of east/,
    );
  });
});

describe('assertBoundingBox', () => {
  const valid: BoundingBox = { west: 20, south: 39, east: 31, north: 46 };

  it('accepts a well-formed box', () => {
    expect(() => assertBoundingBox(valid)).not.toThrow();
  });

  it('rejects a degenerate box', () => {
    expect(() => assertBoundingBox({ ...valid, north: 39 })).toThrow(/strictly south of north/);
  });

  it('rejects a non-finite edge', () => {
    expect(() => assertBoundingBox({ ...valid, west: Number.NaN })).toThrow(/finite number/);
  });

  it('rejects a box off the globe', () => {
    expect(() => assertBoundingBox({ ...valid, north: 91 })).toThrow(/latitudes/);
    expect(() => assertBoundingBox({ ...valid, west: -181 })).toThrow(/longitudes/);
  });
});

describe('expandBboxKm', () => {
  it('grows latitude by the meridian rate', () => {
    const grown = expandBboxKm({ west: 20, south: 39, east: 31, north: 46 }, 111.32);

    expect(grown.south).toBeCloseTo(38, 6);
    expect(grown.north).toBeCloseTo(47, 6);
  });

  it('buys fewer degrees of latitude than of longitude at Balkan latitudes', () => {
    const grown = expandBboxKm(BULGARIA_ENVELOPE, ALERTABLE_BUFFER_KM);

    expect(grown.north - BULGARIA_ENVELOPE.north).toBeLessThan(BULGARIA_ENVELOPE.west - grown.west);
  });
});

describe('assertBboxCovers', () => {
  it('names the edge that is too tight and how short it falls', () => {
    const inner = { west: 20.1, south: 39.1, east: 30.9, north: 45.9 };

    expect(() => assertBboxCovers(POLLING_BBOX.values, inner)).toThrow(/on the west edge/);
    expect(() => assertBboxCovers(POLLING_BBOX.values, inner)).toThrow(/at least 42 km/);
  });

  it('rejects an inner area that reaches outside the poll entirely', () => {
    const inner = { west: 19, south: 38, east: 32, north: 47 };

    expect(() => assertBboxCovers(POLLING_BBOX.values, inner)).toThrow();
  });
});
