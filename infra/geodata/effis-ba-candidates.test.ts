import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FORMAT,
  RULES,
  buildCandidates,
  insideOutline,
  layerUrl,
  outlineFromRegions,
  parseEffisDate,
  parseLayer,
  selectAll,
  selectS1,
  selectS2,
  selectS3,
  selectS6,
  serializeCandidates,
  vertexGapKm,
  type BaFire,
  type CandidatesAsset,
} from './effis-ba-candidates.js';

/** A square ring, closed, `size` degrees on a side. */
function square(lon: number, lat: number, size: number): [number, number][] {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
}

/** Delta-coded flat ring at scale 1000, the oblast asset's encoding. */
function flat(ring: readonly [number, number][]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * 1000);
    const y = Math.round(lat * 1000);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

// "Bulgaria" for these tests: the box 23–25 E, 41–43 N.
const OUTLINE = outlineFromRegions({
  scale: 1000,
  regions: [['BG-01', [flat(square(23, 41, 2))]]],
});

function fire(over: Partial<BaFire> & { id: string; ring: [number, number][] }): BaFire {
  const { ring, ...rest } = over;
  return {
    layer: 'modis.ba.poly.2024',
    country: 'BG',
    province: 'Хасково',
    commune: 'Харманли',
    fireDate: '2024-07-10 10:00:00',
    finalDate: '2024-07-10 12:00:00',
    lastUpdate: '2024-07-20 00:00:00',
    areaHa: 500,
    agriPct: 10,
    rings: [ring],
    ...rest,
  };
}

describe('layerUrl', () => {
  it('asks WFS 1.1.0 for the polling box in lat,lon axis order', () => {
    expect(layerUrl(2024)).toBe(
      'https://maps.effis.emergency.copernicus.eu/effis?SERVICE=WFS&VERSION=1.1.0' +
        '&REQUEST=GetFeature&TYPENAME=modis.ba.poly.2024&OUTPUTFORMAT=geojson' +
        '&BBOX=39,20,46,31,urn:ogc:def:crs:EPSG::4326',
    );
  });
});

describe('parseLayer', () => {
  const props = (id: string, agri: string) => ({
    id,
    FIREDATE: '2024-07-10 10:00:00',
    FINALDATE: '2024-07-11 10:00:00',
    LASTUPDATE: '2024-07-20 00:00:00.123',
    COUNTRY: 'BG',
    PROVINCE: 'Ямбол',
    COMMUNE: 'Елхово',
    AREA_HA: '120',
    AGRIAREAS: agri,
  });

  it('keeps the outer ring of every polygonal member and drops what has none', () => {
    const parsed = parseLayer('modis.ba.poly.2024', {
      features: [
        {
          properties: props('1', '40.5'),
          geometry: { type: 'Polygon', coordinates: [square(23, 41, 1), square(23.2, 41.2, 0.1)] },
        },
        {
          properties: props('2', ''),
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[square(23, 41, 1)], [square(24, 42, 1)]],
          },
        },
        {
          properties: props('3', '0'),
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              {
                type: 'LineString',
                coordinates: [
                  [23, 41],
                  [23.1, 41.1],
                ],
              },
              { type: 'Polygon', coordinates: [square(23, 41, 1)] },
              { type: 'MultiPoint', coordinates: [[23, 41]] },
            ],
          },
        },
        { properties: props('4', '0'), geometry: null },
        {
          properties: props('', '0'),
          geometry: { type: 'Polygon', coordinates: [square(23, 41, 1)] },
        },
      ],
    });
    expect(parsed.dropped).toBe(2);
    expect(parsed.fires.map((f) => [f.id, f.rings.length])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', 1],
    ]);
    expect(parsed.fires[0]).toMatchObject({ areaHa: 120, agriPct: 40.5, province: 'Ямбол' });
    // A blank land-cover share is unknown, not zero.
    expect(parsed.fires[1]?.agriPct).toBeNull();
  });
});

describe('geometry and dates', () => {
  it('reads EFFIS timestamps, fractional seconds and all', () => {
    expect(parseEffisDate('2024-07-10 10:00:00.123456')).toBe(Date.UTC(2024, 6, 10, 10));
    expect(() => parseEffisDate('')).toThrow(RangeError);
  });

  it('decodes the delta-coded outline', () => {
    expect(insideOutline([24, 42], OUTLINE)).toBe(true);
    expect(insideOutline([22.5, 42], OUTLINE)).toBe(false);
  });

  it('measures the vertex gap and gives up past the limit', () => {
    expect(vertexGapKm(square(23, 41, 0.1), square(23.1, 41, 0.1), 1)).toBe(0);
    expect(vertexGapKm(square(23, 41, 0.1), square(24, 41, 0.1), 1)).toBe(Infinity);
  });
});

describe('selectS1', () => {
  it('finds a straddling perimeter and a cross-border pair, never an inland fire', () => {
    const straddle = fire({ id: 's', ring: square(22.9, 41.5, 0.2) }); // half outside the west edge
    const inland = fire({ id: 'i', ring: square(24, 42, 0.2) });
    const bgSide = fire({ id: 'b', ring: square(24.8, 41.5, 0.19) });
    const otherSide = fire({ id: 'o', country: 'EL', ring: square(24.99, 41.5, 0.2) });
    const selection = selectS1([straddle, inland, bgSide, otherSide], OUTLINE);
    const ids = selection.candidates.map((c) => c.fires.map((f) => f.effis_id).join('+'));
    expect(ids).toContain('s');
    expect(ids).toContain('b+o');
    expect(ids).not.toContain('i');
    expect(selection.status).toBe('candidates');
  });

  it('says so when nothing crosses', () => {
    const selection = selectS1([fire({ id: 'i', ring: square(24, 42, 0.2) })], OUTLINE);
    expect(selection).toMatchObject({ status: 'no_fitting_fire', candidates: [] });
  });
});

describe('selectS2', () => {
  const a = fire({ id: 'a', ring: square(26, 41.9, 0.05) });
  const b = fire({ id: 'b', province: 'Ямбол', ring: square(26.05, 41.9, 0.05) });

  it('pairs touching Sakar perimeters whose dates overlap', () => {
    const selection = selectS2([a, b]);
    expect(selection.candidates.map((c) => c.fires.map((f) => f.effis_id))).toEqual([['a', 'b']]);
  });

  it('ignores pairs a week apart, small ones, and other provinces', () => {
    const later = { ...b, fireDate: '2024-07-20 10:00:00', finalDate: '2024-07-20 12:00:00' };
    expect(selectS2([a, later]).candidates).toEqual([]);
    expect(selectS2([a, { ...b, areaHa: RULES.S2.minAreaHa - 1 }]).candidates).toEqual([]);
    expect(selectS2([a, { ...b, province: 'Варна' }]).status).toBe('no_fitting_fire');
  });
});

describe('selectS3', () => {
  it('keeps agricultural perimeters above the threshold, largest first', () => {
    const fires = [
      fire({ id: 'small', agriPct: 100, areaHa: 30, ring: square(24, 42, 0.01) }),
      fire({ id: 'big', agriPct: 96, areaHa: 300, ring: square(24, 42, 0.01) }),
      fire({ id: 'forest', agriPct: 50, areaHa: 900, ring: square(24, 42, 0.01) }),
      fire({ id: 'unknown', agriPct: null, areaHa: 900, ring: square(24, 42, 0.01) }),
      fire({ id: 'tiny', agriPct: 100, areaHa: 5, ring: square(24, 42, 0.01) }),
      fire({ id: 'abroad', agriPct: 100, areaHa: 900, country: 'RO', ring: square(24, 42, 0.01) }),
    ];
    expect(selectS3(fires).candidates.map((c) => c.fires[0]?.effis_id)).toEqual(['big', 'small']);
  });
});

describe('selectS6', () => {
  const mega = fire({
    id: 'mega',
    areaHa: 3000,
    fireDate: '2024-07-10 10:00:00',
    finalDate: '2024-07-13 10:00:00',
    ring: square(26, 41.9, 0.1),
  });

  it('ranks a megafire with a reignition perimeter above a larger one without', () => {
    const bigger = { ...mega, id: 'bigger', areaHa: 9000, rings: [square(24, 42, 0.1)] };
    const reignition = fire({
      id: 'again',
      areaHa: 50,
      fireDate: '2024-07-18 10:00:00',
      finalDate: '2024-07-18 12:00:00',
      ring: square(26.1, 41.9, 0.02),
    });
    const selection = selectS6([bigger, mega, reignition]);
    expect(selection.candidates.map((c) => c.fires.map((f) => f.effis_id))).toEqual([
      ['mega', 'again'],
      ['bigger'],
    ]);
  });

  it('skips short fires and says when no reignition was found', () => {
    const short = { ...mega, id: 'short', finalDate: '2024-07-10 20:00:00' };
    const selection = selectS6([mega, short]);
    expect(selection.candidates.map((c) => c.fires[0]?.effis_id)).toEqual(['mega']);
    expect(selection.note).toContain('No candidate has a reignition perimeter');
  });
});

describe('the asset', () => {
  it('records S4 and S5 as having no burnt-area fire', () => {
    const scenarios = selectAll([], OUTLINE);
    expect(scenarios.map((s) => [s.scenario, s.status])).toEqual([
      ['S1', 'no_fitting_fire'],
      ['S2', 'no_fitting_fire'],
      ['S3', 'no_fitting_fire'],
      ['S4', 'no_fitting_fire'],
      ['S5', 'no_fitting_fire'],
      ['S6', 'no_fitting_fire'],
    ]);
  });

  it('serializes to stable JSON', () => {
    const fires = [fire({ id: 'x', agriPct: 99, areaHa: 40, ring: square(24, 42, 0.01) })];
    const asset = buildCandidates([], fires, OUTLINE, 'test');
    const text = serializeCandidates(asset);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(asset)));
    expect(serializeCandidates(buildCandidates([], fires, OUTLINE, 'test'))).toBe(text);
  });
});

describe('the committed selection', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', 'server', 'fixtures', 'effis-ba-candidates.json');
  const asset = JSON.parse(readFileSync(path, 'utf8')) as CandidatesAsset;

  it('covers S1–S6 and keeps availability.json out of scope', () => {
    expect(asset.format).toBe(FORMAT);
    expect(asset.scenarios.map((s) => s.scenario)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    expect(Object.keys(asset.out_of_scope)).toContain('availability.json');
  });

  it('traces every candidate fire to a hashed source file', () => {
    const layers = new Set(asset.sources.map((s) => s.layer));
    for (const source of asset.sources) expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const scenario of asset.scenarios) {
      for (const candidate of scenario.candidates) {
        for (const f of candidate.fires) {
          expect(layers.has(f.layer)).toBe(true);
          expect(f.effis_id).toMatch(/^\d+$/);
        }
      }
    }
  });
});
