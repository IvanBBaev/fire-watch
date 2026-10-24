import { readFileSync } from 'node:fs';

import { STATIC_SOURCE_METRIC } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PROTECTED_SITES,
  PROTECTED_SITES_FORMAT,
  ProtectedSitesFormatError,
  parseProtectedSites,
  pointInSite,
  protectedSiteDistanceM,
  protectedSiteRelation,
  protectedSitesGeoJson,
  type ProtectedSites,
} from './protected-sites.js';

const METRIC = STATIC_SOURCE_METRIC;

/** A ring in the asset's encoding: absolute first vertex, then deltas, scale 1000. */
function encodedSquare(lon: number, lat: number, size: number): number[] {
  const x = Math.round(lon * 1000);
  const y = Math.round(lat * 1000);
  const s = Math.round(size * 1000);
  return [x, y, s, 0, 0, s, -s, 0];
}

function asset(sites: unknown[]): Record<string, unknown> {
  return {
    format: PROTECTED_SITES_FORMAT,
    version: 'natura2000_test',
    licence: 'CC-BY-4.0',
    attribution: 'test',
    scale: 1000,
    types: ['spa', 'sci', 'spa_sci'],
    sites,
  };
}

// Two sites side by side at 42–43° N, 0.2° apart; the first has a hole.
const SITES: ProtectedSites = parseProtectedSites(
  asset([
    ['BG0000001', 'Alpha', 1, [[encodedSquare(24, 42, 0.5), encodedSquare(24.2, 42.2, 0.1)]]],
    ['BG0000002', 'Beta', 0, [[encodedSquare(24.7, 42, 0.5)]]],
  ]),
);

describe('parseProtectedSites', () => {
  it('decodes rings to degrees and keeps code, name and type', () => {
    const [alpha, beta] = SITES.sites;
    expect(alpha?.code).toBe('BG0000001');
    expect(alpha?.type).toBe('sci');
    expect(beta?.type).toBe('spa');
    expect(alpha?.parts[0]?.outer.slice(0, 4)).toEqual([24, 42, 24.5, 42]);
    expect(alpha?.parts[0]?.holes).toHaveLength(1);
    expect([alpha?.minLon, alpha?.maxLat]).toEqual([24, 42.5]);
  });

  it.each([
    ['a wrong format', { ...asset([]), format: 'other' }],
    ['an unknown type', asset([['X', 'X', 7, [[encodedSquare(24, 42, 1)]]]])],
    ['a two-vertex ring', asset([['X', 'X', 0, [[[24000, 42000, 1, 1]]]]])],
    ['a fractional coordinate', asset([['X', 'X', 0, [[[24000.5, 42000, 1, 0, 0, 1]]]]])],
    ['a site with no parts', asset([['X', 'X', 0, []]])],
  ])('refuses %s', (_, body) => {
    expect(() => parseProtectedSites(body)).toThrow(ProtectedSitesFormatError);
  });
});

describe('pointInSite and protectedSiteDistanceM', () => {
  const alpha = SITES.sites[0];
  if (alpha === undefined) throw new Error('fixture');

  it('is inside the outer ring and outside its hole', () => {
    expect(pointInSite(24.1, 42.1, alpha)).toBe(true);
    expect(pointInSite(24.25, 42.25, alpha)).toBe(false);
    expect(protectedSiteDistanceM(alpha, 24.1, 42.1, METRIC)).toBe(0);
  });

  it('measures a point in the hole to the hole edge', () => {
    // 0.05° to every edge of the hole; the east-west edges are the nearer, at ~4.1 km.
    const kmPerLon =
      METRIC.kmPerDegreeLonAtReference +
      METRIC.kmPerDegreeLonPerDegreeLat * (42.25 - METRIC.referenceLatDeg);
    expect(protectedSiteDistanceM(alpha, 24.25, 42.25, METRIC)).toBe(
      Math.round(0.05 * kmPerLon * 1000),
    );
  });

  it('measures east-west on the local plane at the point', () => {
    const d = protectedSiteDistanceM(alpha, 24.55, 42.25, METRIC);
    const kmPerLon =
      METRIC.kmPerDegreeLonAtReference +
      METRIC.kmPerDegreeLonPerDegreeLat * (42.25 - METRIC.referenceLatDeg);
    expect(d).toBe(Math.round(0.05 * kmPerLon * 1000));
  });
});

describe('protectedSiteRelation', () => {
  it('says inside, with how many positions fell in the site', () => {
    const relation = protectedSiteRelation(
      SITES,
      [
        { lon: 24.1, lat: 42.1 },
        { lon: 24.12, lat: 42.1 },
        { lon: 24.75, lat: 42.1 },
        { lon: 30, lat: 40 },
      ],
      METRIC,
    );
    expect(relation).toMatchObject({ relation: 'inside', inside: 2, total: 4 });
    expect(relation?.site.code).toBe('BG0000001');
  });

  it('breaks a tie in the count by code', () => {
    const relation = protectedSiteRelation(
      SITES,
      [
        { lon: 24.75, lat: 42.1 },
        { lon: 24.1, lat: 42.1 },
      ],
      METRIC,
    );
    expect(relation?.site.code).toBe('BG0000001');
  });

  it('says near the nearest site within the radius when nothing is inside', () => {
    // 24.6 is 0.1° (~8.2 km) from Alpha's east edge and from Beta's west edge: the tie
    // goes by code; a step east makes Beta the nearer, inside the default 5 km.
    expect(protectedSiteRelation(SITES, [{ lon: 24.6, lat: 42.25 }], METRIC, 10_000)).toMatchObject(
      {
        relation: 'near',
        site: { code: 'BG0000001' },
      },
    );
    const near = protectedSiteRelation(SITES, [{ lon: 24.65, lat: 42.25 }], METRIC);
    expect(near).toMatchObject({ relation: 'near', site: { code: 'BG0000002' } });
    expect(near?.relation === 'near' && near.distanceM).toBeGreaterThan(3000);
  });

  it('says nothing beyond the radius, with no positions, or with nothing loaded', () => {
    expect(protectedSiteRelation(SITES, [{ lon: 26, lat: 44 }], METRIC)).toBeNull();
    expect(protectedSiteRelation(SITES, [{ lon: 24.65, lat: 42.25 }], METRIC, 1000)).toBeNull();
    expect(protectedSiteRelation(SITES, [], METRIC)).toBeNull();
    expect(
      protectedSiteRelation(EMPTY_PROTECTED_SITES, [{ lon: 24.1, lat: 42.1 }], METRIC),
    ).toBeNull();
  });
});

describe('protectedSitesGeoJson', () => {
  it('closes every ring and keeps the hole after its outer ring', () => {
    const geojson = protectedSitesGeoJson(SITES);
    const [alpha] = geojson.features;
    const [outer, hole] = alpha?.geometry.coordinates[0] ?? [];
    expect(outer?.[0]).toEqual(outer?.[outer.length - 1]);
    expect(hole).toHaveLength(5);
    expect(alpha?.properties).toEqual({ code: 'BG0000001', name: 'Alpha', type: 'sci' });
  });
});

describe('the shipped Natura 2000 asset', () => {
  const shipped = parseProtectedSites(
    JSON.parse(
      readFileSync(new URL('../../assets/geodata/natura2000.json', import.meta.url), 'utf8'),
    ) as unknown,
  );

  it('carries the sites of the three member states in the served box', () => {
    expect(shipped.version).toBe('natura2000_2024');
    expect(shipped.licence).toBe('CC-BY-4.0');
    const states = new Set(shipped.sites.map((s) => s.code.slice(0, 2)));
    expect([...states].sort()).toEqual(['BG', 'GR', 'RO']);
    expect(shipped.sites.length).toBeGreaterThan(800);
  });

  it('places known peaks inside their parks and the centre of Sofia in none', () => {
    const at = (lon: number, lat: number) =>
      protectedSiteRelation(shipped, [{ lon, lat }], METRIC, 0);
    expect(at(23.585, 42.179)?.site.code).toBe('BG0000495'); // Musala, Rila
    expect(at(23.398, 41.767)?.site.code).toBe('BG0000209'); // Vihren, Pirin
    expect(at(23.3219, 42.6977)).toBeNull();
  });
});
