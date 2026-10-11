import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { effisDateMs, parseEffisPerimeters } from './effis-perimeters.js';

const square = [
  [23, 42.7],
  [23.1, 42.7],
  [23.1, 42.8],
  [23, 42.7],
];

function feature(properties: Record<string, unknown>, geometry: unknown = null) {
  return {
    type: 'Feature',
    properties,
    geometry: geometry ?? { type: 'Polygon', coordinates: [square, [[0, 0]]] },
  };
}

const OK = { id: 7, FIREDATE: '2024-07-10 13:30:00', FINALDATE: '2024-07-12', AREA_HA: '42.5' };

describe('parseEffisPerimeters (DS-3)', () => {
  it('reads id, dates as UTC, area and outer rings', () => {
    const { perimeters, rejected } = parseEffisPerimeters('2024', {
      type: 'FeatureCollection',
      features: [feature(OK)],
    });
    expect(perimeters).toEqual([
      {
        fireId: '2024/7',
        startMs: epochMsFromIso('2024-07-10T13:30:00Z'),
        endMs: epochMsFromIso('2024-07-12T00:00:00Z'),
        areaHa: 42.5,
        rings: [square],
      },
    ]);
    expect(Object.values(rejected).every((n) => n === 0)).toBe(true);
  });

  it('closes an unfinished fire at FIREDATE and reads every polygonal geometry', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[square], [square]] };
    const collection = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        { type: 'Polygon', coordinates: [square] },
      ],
    };
    const { perimeters } = parseEffisPerimeters('2024', {
      features: [
        feature({ ...OK, id: 'a', FINALDATE: '' }, multi),
        feature({ ...OK, id: 'b' }, collection),
      ],
    });
    expect(perimeters[0]?.endMs).toBe(perimeters[0]?.startMs);
    expect(perimeters[0]?.rings).toHaveLength(2);
    expect(perimeters[1]?.rings).toEqual([square]);
  });

  it('counts every drop by reason and sorts what it keeps', () => {
    const { perimeters, rejected } = parseEffisPerimeters('2024', {
      features: [
        feature({ ...OK, id: 'z' }),
        feature({ ...OK, id: '' }),
        feature({ ...OK, id: 'p' }, { type: 'Point', coordinates: [1, 2] }),
        feature({ ...OK, id: 'q', AREA_HA: '' }),
        feature({ ...OK, id: 'r', FIREDATE: '10/07/2024' }),
        feature({ ...OK, id: 's', FINALDATE: '2024-07-01' }),
        feature({ ...OK, id: 'a' }),
        feature({ ...OK, id: 'a' }),
      ],
    });
    expect(perimeters.map((p) => p.fireId)).toEqual(['2024/a', '2024/z']);
    expect(rejected).toEqual({
      no_id: 1,
      no_polygon: 1,
      no_area: 1,
      bad_date: 2,
      duplicate_id: 1,
    });
  });

  it('refuses something that is not a FeatureCollection', () => {
    expect(() => parseEffisPerimeters('2024', [])).toThrow(TypeError);
  });
});

describe('effisDateMs', () => {
  it('reads a bare date, minutes and seconds as UTC, and nothing else', () => {
    expect(effisDateMs('2024-07-10')).toBe(epochMsFromIso('2024-07-10T00:00:00Z'));
    expect(effisDateMs('2024-07-10 08:15')).toBe(epochMsFromIso('2024-07-10T08:15:00Z'));
    expect(effisDateMs('2024-07-10T08:15:30')).toBe(epochMsFromIso('2024-07-10T08:15:30Z'));
    expect(effisDateMs('2024-13-40')).toBeNull();
    expect(effisDateMs('July 10')).toBeNull();
  });
});
