import { describe, expect, it } from 'vitest';

import {
  FORMAT,
  assembleRings,
  buildStaticSources,
  kindOf,
  serializeStaticSources,
  simplifyLine,
  simplifyRing,
  type OverpassElement,
} from './static-sources.js';

const PROVENANCE = { source: 'test', querySha256: 'q', responseSha256: 'r' };

function square(lon: number, lat: number, size: number) {
  return [
    { lon, lat },
    { lon: lon + size, lat },
    { lon: lon + size, lat: lat + size },
    { lon, lat: lat + size },
    { lon, lat },
  ];
}

function build(elements: readonly OverpassElement[]) {
  return buildStaticSources(
    { osm3s: { timestamp_osm_base: '2026-09-30T13:19:30Z' }, elements },
    PROVENANCE,
  );
}

describe('kindOf', () => {
  it.each([
    [{ power: 'plant', 'plant:source': 'solar' }, 'solar'],
    [{ power: 'plant', 'plant:source': 'lignite' }, 'thermal_power'],
    [{ power: 'plant', 'plant:source': 'hydro' }, null],
    [{ man_made: 'flare' }, 'flare'],
    [{ landuse: 'industrial', industrial: 'refinery' }, 'industrial'],
    [{ industrial: 'bakery' }, null],
    [undefined, null],
  ])('%j → %s', (tags, kind) => {
    expect(kindOf(tags)).toBe(kind);
  });
});

describe('simplification', () => {
  it('drops a vertex within tolerance and keeps one beyond it', () => {
    expect(
      simplifyLine(
        [
          [0, 0],
          [50, 1],
          [100, 0],
        ],
        2,
      ),
    ).toEqual([
      [0, 0],
      [100, 0],
    ]);
    expect(
      simplifyLine(
        [
          [0, 0],
          [50, 10],
          [100, 0],
        ],
        2,
      ),
    ).toHaveLength(3);
  });

  it('keeps a ring’s extent', () => {
    const ring: [number, number][] = [
      [0, 0],
      [50, 1],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    expect(simplifyRing(ring, 2)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });
});

describe('assembleRings', () => {
  it('stitches outer ways end to end in either direction', () => {
    const { rings, unclosed } = assembleRings([
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 10],
        [10, 0],
      ],
      [
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    expect(unclosed).toBe(0);
    expect(rings).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ]);
  });

  it('counts a fragment that will not close', () => {
    expect(
      assembleRings([
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      ]).unclosed,
    ).toBe(1);
  });
});

describe('buildStaticSources', () => {
  const elements: OverpassElement[] = [
    {
      type: 'way',
      id: 2,
      tags: { power: 'plant', 'plant:source': 'solar' },
      geometry: square(25, 42, 0.01),
    },
    { type: 'node', id: 7, lat: 43, lon: 26, tags: { man_made: 'flare' } },
    {
      type: 'relation',
      id: 3,
      tags: { industrial: 'refinery', type: 'multipolygon' },
      members: [
        { type: 'way', role: 'outer', geometry: square(27, 42.5, 0.05) },
        { type: 'way', role: 'inner', geometry: square(27.01, 42.51, 0.01) },
      ],
    },
    { type: 'way', id: 9, tags: { building: 'yes' }, geometry: square(0, 0, 1) },
    {
      type: 'way',
      id: 4,
      tags: { power: 'plant', 'plant:source': 'solar' },
      geometry: square(24, 42, 0.00005), // collapses to one grid cell
    },
    {
      type: 'way',
      id: 5,
      tags: { power: 'plant', 'plant:source': 'coal' },
      geometry: square(23, 42, 0.01).slice(0, 4), // not closed
    },
  ];

  it('encodes kinds, keeps outer rings only, turns a collapsed ring into a point', () => {
    const built = build(elements);
    expect(built.format).toBe(FORMAT);
    expect(built.version).toBe('osm-2026-09-30');
    expect(built.counts).toEqual({ solar: 2, thermal_power: 0, industrial: 1, flare: 1 });
    expect(built.dropped).toEqual({ open: 1, unclosedOuter: 0 });
    expect(built.sources).toEqual([
      [0, 250_000, 420_000, 100, 0, 0, 100, -100, 0],
      [0, 240_000, 420_000],
      [2, 270_000, 425_000, 500, 0, 0, 500, -500, 0],
      [3, 260_000, 430_000],
    ]);
  });

  it('is independent of element order', () => {
    const forward = serializeStaticSources(build(elements));
    expect(serializeStaticSources(build([...elements].reverse()))).toBe(forward);
  });

  it('serializes as parseable JSON, one source per line', () => {
    const text = serializeStaticSources(build(elements));
    expect(JSON.parse(text)).toEqual(build(elements));
    expect(text.split('\n')).toHaveLength(4 + 3);
  });
});
