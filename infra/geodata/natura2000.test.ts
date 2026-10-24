import { describe, expect, it } from 'vitest';

import {
  FORMAT,
  MIN_AREA_UNITS2,
  buildNatura2000,
  clipRing,
  pageUrl,
  prepareSite,
  serializeNatura2000,
  signedArea,
  type SiteFeature,
} from './natura2000.js';

const PROVENANCE = { source: 'test', release: '2024', pagesSha256: 'p' };

/** A closed counter-clockwise square, as the service writes rings. */
function square(lon: number, lat: number, size: number): number[][] {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
}

function site(
  code: string,
  type: string,
  coordinates: number[][][][],
  released: number | null = null,
): SiteFeature {
  return {
    properties: {
      SITECODE: code,
      SITENAME: ` Site ${code} `,
      SITETYPE: type,
      RELEASE_DATE: released,
    },
    geometry: { type: 'MultiPolygon', coordinates },
  };
}

/** Undo the per-ring delta encoding. */
function decode(ring: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i] as number;
    y += ring[i + 1] as number;
    out.push([x, y]);
  }
  return out;
}

describe('clipRing', () => {
  it('cuts a ring that crosses the box edge at the edge', () => {
    const clipped = clipRing(square(30.5, 42, 1).map(([x, y]) => [x as number, y as number]));
    expect(Math.max(...clipped.map((p) => p[0]))).toBe(31);
    expect(Math.min(...clipped.map((p) => p[0]))).toBe(30.5);
  });

  it('leaves nothing of a ring wholly outside the box', () => {
    expect(clipRing(square(32, 42, 1).map(([x, y]) => [x as number, y as number]))).toEqual([]);
  });
});

describe('prepareSite', () => {
  it('winds the outer ring counter-clockwise and a hole clockwise', () => {
    const outer = square(23, 42, 1).reverse(); // clockwise on the way in
    const hole = square(23.2, 42.2, 0.5); // counter-clockwise on the way in
    const { parts } = prepareSite(site('BG0000001', 'B', [[outer, hole]]));
    const [part] = parts;
    expect(part).toHaveLength(2);
    expect(signedArea(decode(part?.[0] ?? []))).toBeGreaterThan(0);
    expect(signedArea(decode(part?.[1] ?? []))).toBeLessThan(0);
  });

  it('drops a sliver part and a sliver hole but always keeps the largest part', () => {
    const tiny = square(25, 43, 0.001);
    const { parts, droppedParts, droppedHoles } = prepareSite(
      site('BG0000002', 'A', [[square(24, 42, 1), square(24.5, 42.5, 0.002)], [tiny]]),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(1);
    expect(droppedParts).toBe(1);
    expect(droppedHoles).toBe(1);

    // A site whose only part is below the size rule is still kept, so it can be named.
    const alone = prepareSite(site('BG0000003', 'A', [[square(25, 43, 0.002)]]));
    expect(alone.parts).toHaveLength(1);
    expect(Math.abs(signedArea(decode(alone.parts[0]?.[0] ?? [])))).toBeLessThan(MIN_AREA_UNITS2);
  });

  it('returns no parts for a site that only touches the box from outside', () => {
    expect(prepareSite(site('TR0000001', 'B', [[square(31.5, 42, 1)]])).parts).toEqual([]);
  });
});

describe('buildNatura2000', () => {
  const features = [
    site('RO0000002', 'C', [[square(26, 44, 0.5)]], Date.UTC(2025, 0, 25)),
    site('BG0000001', 'B', [[square(23, 42, 1)]], Date.UTC(2024, 0, 1)),
    site('BG0000001', 'B', [[square(23, 42, 1)]]), // the same site on two pages
    site('GR0000003', 'A', [[square(40, 40, 1)]]),
  ];

  it('sorts by code, de-duplicates, counts by type and records the newest release', () => {
    const asset = buildNatura2000(features, PROVENANCE);
    expect(asset.format).toBe(FORMAT);
    expect(asset.version).toBe('natura2000_2024');
    expect(asset.sites.map((s) => s[0])).toEqual(['BG0000001', 'RO0000002']);
    expect(asset.sites[0]?.[1]).toBe('Site BG0000001');
    expect(asset.sites.map((s) => s[2])).toEqual([1, 2]);
    expect(asset.counts).toEqual({ spa: 0, sci: 1, spa_sci: 1 });
    expect(asset.dropped.outside).toBe(1);
    expect(asset.release_date).toBe('2025-01-25');
    expect(decode(asset.sites[0]?.[3][0]?.[0] ?? [])[0]).toEqual([23000, 42000]);
  });

  it('refuses a site type it does not know', () => {
    expect(() => buildNatura2000([site('BG0000009', 'X', [])], PROVENANCE)).toThrow(/SITETYPE/);
  });

  it('serializes one site per line and round-trips through JSON', () => {
    const asset = buildNatura2000(features, PROVENANCE);
    const text = serializeNatura2000(asset);
    expect(text.split('\n').filter((l) => l.startsWith('["'))).toHaveLength(2);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(asset)));
  });
});

describe('pageUrl', () => {
  it('pages the sites layer in a stable order over the served box', () => {
    const url = new URL(pageUrl(200));
    expect(url.pathname.endsWith('/MapServer/2/query')).toBe(true);
    expect(url.searchParams.get('geometry')).toBe('20,39,31,46');
    expect(url.searchParams.get('orderByFields')).toBe('SITECODE');
    expect(url.searchParams.get('resultOffset')).toBe('200');
  });
});
