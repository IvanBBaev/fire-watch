import { describe, expect, it } from 'vitest';

import {
  OUTLINE_SERIES_SCHEMA_VERSION,
  OUTLINE_SERIES_URL_TEMPLATE,
  outlineSeriesUrl,
  parseOutlineSeries,
} from './outline-series.js';

const POINT = {
  at: '2026-08-09T01:02:00Z',
  area_ha: 14,
  area_low_ha: 10,
  area_high_ha: 18,
  edge_uncertainty_km: 0.21,
  footprints: 1,
  centroid: [27.516, 41.977],
};

const DOCUMENT = {
  schema_version: OUTLINE_SERIES_SCHEMA_VERSION,
  kind: 'estimated_outline_series',
  event_id: 'fw-2026-b2n5c',
  merged_into: null,
  params_version: 'fire_outline_params_v1',
  generated_at: '2026-08-09T10:15:00Z',
  truncated: false,
  thinned: false,
  points: [POINT, { ...POINT, at: '2026-08-09T11:40:00Z', area_ha: 30, area_high_ha: 40 }],
  attribution: [{ id: 'firms', source: 'NASA FIRMS', text: 'NASA FIRMS', href: 'https://x' }],
};

describe('parseOutlineSeries', () => {
  it('accepts a well-formed document unchanged', () => {
    expect(parseOutlineSeries(DOCUMENT)).toEqual(DOCUMENT);
  });

  it('accepts a merge tombstone with no points', () => {
    const tombstone = { ...DOCUMENT, merged_into: 'fw-2026-k9s2r', points: [] };
    expect(parseOutlineSeries(tombstone)).toEqual(tombstone);
  });

  it.each([
    ['another schema version', { schema_version: 2 }],
    ['another kind', { kind: 'perimeter' }],
    ['an empty event id', { event_id: '' }],
    ['a local time', { generated_at: '2026-08-09T10:15:00' }],
    ['a non-boolean flag', { thinned: 'no' }],
    ['points on a tombstone', { merged_into: 'fw-2026-k9s2r' }],
    ['points out of order', { points: [DOCUMENT.points[1], DOCUMENT.points[0]] }],
    ['a repeated instant', { points: [POINT, POINT] }],
    ['an area outside its band', { points: [{ ...POINT, area_ha: 20 }] }],
    ['a zero edge uncertainty', { points: [{ ...POINT, edge_uncertainty_km: 0 }] }],
    ['no footprints', { points: [{ ...POINT, footprints: 0 }] }],
    ['a centroid off the globe', { points: [{ ...POINT, centroid: [200, 41] }] }],
    ['a malformed credit', { attribution: [{ id: 'firms' }] }],
  ])('refuses %s', (_label, change) => {
    expect(parseOutlineSeries({ ...DOCUMENT, ...change })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, [], 'x', 1]) expect(parseOutlineSeries(value)).toBeNull();
  });
});

describe('outlineSeriesUrl', () => {
  it('fills the event id into the template', () => {
    expect(outlineSeriesUrl(OUTLINE_SERIES_URL_TEMPLATE, 'fw-2026-b2n5c')).toBe(
      '/api/v1/events/fw-2026-b2n5c/outline-series',
    );
  });
});
