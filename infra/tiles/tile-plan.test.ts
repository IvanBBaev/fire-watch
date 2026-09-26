import { describe, expect, it } from 'vitest';

import {
  clientUrlTemplates,
  countTiles,
  DEFAULT_EXTRACT_TIERS,
  enumerateTiles,
  type ExtractTier,
  headersFor,
  IMMUTABLE_CACHE_CONTROL,
  isValidKey,
  lonLatToTile,
  MAX_TILE_ZOOM,
  planUpload,
  rcloneCommand,
  tierCovers,
  tileRange,
  vectorTileKey,
} from './tile-plan.js';

const SOFIA = { lon: 23.32, lat: 42.7 };
/** Slavyanka / the Greek border — the S1 view of G2. */
const SLAVYANKA = { lon: 23.6, lat: 41.4 };
/** `polling_bbox_v1` (server/src/core/config/polling-bbox.ts). */
const POLLING_BBOX = { west: 20, south: 39, east: 31, north: 46 };

describe('tile math', () => {
  it('matches the OSM slippy-map reference tiles', () => {
    expect(lonLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
    expect(lonLatToTile(0, 0, 10)).toEqual({ x: 512, y: 512 });
    // Sofia at z10, worked by hand from the slippy-map formula.
    expect(lonLatToTile(SOFIA.lon, SOFIA.lat, 10)).toEqual({ x: 578, y: 377 });
    // The antimeridian and the poles clamp instead of overflowing.
    expect(lonLatToTile(180, 90, 3)).toEqual({ x: 7, y: 0 });
    expect(lonLatToTile(-180, -90, 3)).toEqual({ x: 0, y: 7 });
  });

  it('turns a bbox into an inclusive range with north at the lower y', () => {
    const range = tileRange({ west: -180, south: -85, east: 180, north: 85 }, 2);
    expect(range).toEqual({ z: 2, minX: 0, maxX: 3, minY: 0, maxY: 3 });
  });

  it('counts a single tier as the product of its ranges', () => {
    const tier: ExtractTier = { name: 't', bbox: POLLING_BBOX, minzoom: 0, maxzoom: 6 };
    const estimate = countTiles([tier]);
    let expected = 0;
    for (let z = 0; z <= 6; z += 1) {
      const r = tileRange(POLLING_BBOX, z);
      expected += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    }
    expect(estimate.total).toBe(expected);
    expect(estimate.byZoom[0]).toEqual({ z: 0, tiles: 1 });
  });

  it('counts overlapping tiers once and agrees with enumeration', () => {
    const tiers: ExtractTier[] = [
      { name: 'wide', bbox: { west: 10, south: 35, east: 40, north: 50 }, minzoom: 0, maxzoom: 6 },
      { name: 'narrow', bbox: POLLING_BBOX, minzoom: 0, maxzoom: 8 },
      { name: 'disjoint', bbox: { west: -10, south: 50, east: -5, north: 55 }, minzoom: 4, maxzoom: 7 },
    ];
    const estimate = countTiles(tiers);
    const enumerated = [...enumerateTiles(tiers)];
    expect(enumerated).toHaveLength(estimate.total);
    expect(new Set(enumerated.map((t) => `${t.z}/${t.x}/${t.y}`)).size).toBe(estimate.total);
    for (const tile of enumerated) expect(tierCovers(tiers, tile)).toBe(true);
    expect(estimate.maxzoom).toBe(8);
  });

  it('keeps the default plan at max z14 with the polling box and the border inside detail', () => {
    const detail = DEFAULT_EXTRACT_TIERS.filter((tier) => tier.maxzoom === MAX_TILE_ZOOM);
    expect(detail.length).toBeGreaterThan(0);
    expect(Math.max(...DEFAULT_EXTRACT_TIERS.map((tier) => tier.maxzoom))).toBe(MAX_TILE_ZOOM);
    const inside = (lon: number, lat: number) =>
      detail.some(({ bbox }) => lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north);
    expect(inside(POLLING_BBOX.west, POLLING_BBOX.south)).toBe(true);
    expect(inside(POLLING_BBOX.east, POLLING_BBOX.north)).toBe(true);
    expect(inside(SLAVYANKA.lon, SLAVYANKA.lat)).toBe(true);
    const z14 = lonLatToTile(SLAVYANKA.lon, SLAVYANKA.lat, 14);
    expect(tierCovers(DEFAULT_EXTRACT_TIERS, { z: 14, ...z14 })).toBe(true);
    // A sanity bound on cost: the default plan is under a million PUTs.
    const { total } = countTiles(DEFAULT_EXTRACT_TIERS);
    expect(total).toBeGreaterThan(100_000);
    expect(total).toBeLessThan(1_000_000);
  });

  it('rejects impossible tiers', () => {
    expect(() => countTiles([{ name: 'x', bbox: POLLING_BBOX, minzoom: 0, maxzoom: 15 }])).toThrow(/maxzoom/);
    expect(() =>
      countTiles([{ name: 'x', bbox: { ...POLLING_BBOX, west: 40 }, minzoom: 0, maxzoom: 4 }]),
    ).toThrow(/west/);
    expect(() => countTiles([{ name: 'x', bbox: POLLING_BBOX, minzoom: 5, maxzoom: 4 }])).toThrow(/minzoom/);
    expect(() => countTiles([])).toThrow(/no extract tiers/);
  });
});

describe('key layout and headers', () => {
  it('versions every vector key and keeps it a valid object key', () => {
    const key = vectorTileKey('20260924', { z: 14, x: 9266, y: 6097 });
    expect(key).toBe('tiles/20260924/14/9266/6097.mvt');
    expect(isValidKey(key)).toBe(true);
    expect(() => vectorTileKey('latest', { z: 0, x: 0, y: 0 })).toThrow(/version/);
    expect(() => vectorTileKey('../x', { z: 0, x: 0, y: 0 })).toThrow(/version/);
  });

  it('validates keys like the E3 mirror, with spaces only for fontstacks', () => {
    expect(isValidKey('fonts/20260924/Noto Sans Regular/0-255.pbf')).toBe(false);
    expect(isValidKey('fonts/20260924/Noto Sans Regular/0-255.pbf', { allowSpaces: true })).toBe(true);
    expect(isValidKey('tiles/../x')).toBe(false);
    expect(isValidKey('tiles//x')).toBe(false);
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('fonts/ leading/0-255.pbf', { allowSpaces: true })).toBe(false);
  });

  it('serves every tree immutable, and gzip tiles with Content-Encoding', () => {
    expect(headersFor('vector')).toEqual({
      contentType: 'application/vnd.mapbox-vector-tile',
      contentEncoding: 'gzip',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    expect(headersFor('vector', 'none').contentEncoding).toBeNull();
    expect(headersFor('glyphs')).toMatchObject({ contentType: 'application/x-protobuf', contentEncoding: null });
    expect(headersFor('dem').contentType).toBe('image/png');
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('builds the client URL templates MapLibre expects', () => {
    expect(clientUrlTemplates('https://tiles.example.org/', '20260924', '20260924-2')).toEqual({
      tilesUrl: 'https://tiles.example.org/tiles/20260924/{z}/{x}/{y}.mvt',
      glyphsUrl: 'https://tiles.example.org/fonts/20260924-2/{fontstack}/{range}.pbf',
      demTilesUrl: 'https://tiles.example.org/dem/terrarium/{z}/{x}/{y}.png',
    });
    expect(() => clientUrlTemplates('http://tiles.example.org', '20260924', '20260924')).toThrow(/https/);
  });
});

describe('upload plan', () => {
  const input = {
    tilesDir: '/build/tiles',
    tilesVersion: '20260924',
    tileCount: 123,
    tileCompression: 'gzip' as const,
    glyphsDir: '/build/fonts',
    glyphsVersion: '20260924',
    glyphCount: 45,
  };

  it('uploads glyphs before tiles and has no pointer object', () => {
    const steps = planUpload(input);
    expect(steps.map((step) => step.prefix)).toEqual(['fonts/20260924', 'tiles/20260924']);
    expect(steps.map((step) => step.objects)).toEqual([45, 123]);
    expect(planUpload({ ...input, glyphsDir: null }).map((step) => step.label)).toEqual(['vector tiles']);
    expect(() => planUpload({ ...input, glyphsVersion: null })).toThrow(/glyphsVersion/);
  });

  it('renders rclone commands that stamp the headers on every PUT', () => {
    const [glyphs, tiles] = planUpload(input);
    if (glyphs === undefined || tiles === undefined) throw new Error('expected two steps');
    const command = rcloneCommand(tiles, 'r2:fire-watch-tiles');
    expect(command).toContain(`rclone copy '/build/tiles' 'r2:fire-watch-tiles/tiles/20260924'`);
    expect(command).toContain(`--header-upload 'Content-Type: application/vnd.mapbox-vector-tile'`);
    expect(command).toContain(`--header-upload 'Content-Encoding: gzip'`);
    expect(command).toContain(`--header-upload 'Cache-Control: public, max-age=31536000, immutable'`);
    expect(rcloneCommand(glyphs, 'r2:b')).not.toContain('Content-Encoding');
    expect(() => rcloneCommand(tiles, 'r2:b; rm -rf /')).toThrow(/remote/);
    expect(rcloneCommand({ ...tiles, localDir: "/it's" }, 'r2:b')).toContain(`'/it'\\''s'`);
  });
});
