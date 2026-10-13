import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPacer,
  demBounds,
  DEM_MANIFEST_FORMAT,
  DEM_MAXZOOM,
  DEM_SOURCE,
  type DemFetchResponse,
  demManifestPath,
  demSizeOnDisk,
  demTileFile,
  demUploadStep,
  demTileUrl,
  demTiers,
  emptyDemManifest,
  mirrorDem,
  parseDemManifest,
  planDemMirror,
  readDemManifest,
  retryDelayMs,
  sha256Hex,
  summarizeDemManifest,
  terrariumPngProblem,
  verifyDemMirror,
} from './dem-mirror.js';
import { countTiles, enumerateTiles, type ExtractTier, rcloneCommand, type TileCoord } from './tile-plan.js';

/** The reduced tiers of the 2026-10-10 local basemap build (`tiles/tiers-local.json`). */
const BG_BORDER: ExtractTier = {
  name: 'bg-border',
  bbox: { west: 22.3, south: 40.4, east: 28.7, north: 44.3 },
  minzoom: 0,
  maxzoom: 14,
};
const EUROPE: ExtractTier = {
  name: 'europe',
  bbox: { west: -25, south: 34, east: 45, north: 72 },
  minzoom: 0,
  maxzoom: 6,
};

/** The 33 bytes a Terrarium PNG starts with, plus a fake body. */
function png(width = 256, height = 256, bitDepth = 8, colorType = 2, body = 'IDAT'): Uint8Array {
  const bytes = new Uint8Array(33 + body.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = bitDepth;
  bytes[25] = colorType;
  bytes.set([...body].map((c) => c.charCodeAt(0)), 33);
  return bytes;
}

function work(): string {
  return mkdtempSync(join(tmpdir(), 'fire-watch-dem-'));
}

describe('DEM tile plan (TASKS G3)', () => {
  it('caps the basemap tiers at z12 and drops a tier that starts above the cap', () => {
    expect(DEM_MAXZOOM).toBe(12);
    expect(demTiers([EUROPE, BG_BORDER])).toEqual([EUROPE, { ...BG_BORDER, maxzoom: 12 }]);
    expect(demTiers([{ ...BG_BORDER, minzoom: 13 }, EUROPE], 12)).toEqual([EUROPE]);
    expect(() => demTiers([{ ...BG_BORDER, minzoom: 13 }], 12)).toThrow(/no tier/);
    expect(() => demTiers([BG_BORDER], 16)).toThrow(RangeError);
    expect(() => demTiers([BG_BORDER], 1.5)).toThrow(RangeError);
  });

  it('derives the client bounds from the tiers: the box around all of them, never a guess', () => {
    expect(demBounds(demTiers([EUROPE, BG_BORDER]))).toEqual([-25, 34, 45, 72]);
    expect(demBounds([BG_BORDER])).toEqual([22.3, 40.4, 28.7, 44.3]);
    const east: ExtractTier = { ...BG_BORDER, name: 'east', bbox: { west: 30, south: 39, east: 31, north: 46 } };
    expect(demBounds([BG_BORDER, east])).toEqual([22.3, 39, 31, 46]);
    expect(() => demBounds([])).toThrow(/no extent/);
    expect(() => demBounds([{ ...BG_BORDER, bbox: { ...BG_BORDER.bbox, west: 29 } }])).toThrow(RangeError);
  });

  it('counts the real bg-border plan: 4514 tiles at z12, as the vector build saw', () => {
    const counts = countTiles(demTiers([EUROPE, BG_BORDER]));
    expect(counts.maxzoom).toBe(12);
    expect(counts.byZoom.find((row) => row.z === 12)?.tiles).toBe(4514);
    expect(counts.byZoom.find((row) => row.z === 13)).toBeUndefined();
  });

  it('builds upstream URLs and the bucket-key file layout', () => {
    const tile = { z: 9, x: 290, y: 190 };
    expect(demTileUrl(tile)).toBe('https://elevation-tiles-prod.s3.amazonaws.com/terrarium/9/290/190.png');
    expect(demTileUrl(tile, 'http://mirror/{z}-{x}-{y}')).toBe('http://mirror/9-290-190');
    expect(demTileFile('/w', tile)).toBe(join('/w', 'dem', 'terrarium', '9', '290', '190.png'));
    expect(demManifestPath('/w')).toBe(join('/w', 'dem', 'manifest.json'));
    expect(DEM_SOURCE.licence).toMatch(/tilezen\/joerd/);
  });

  it('uploads the mirror to the key clientUrlTemplates points demTilesUrl at', () => {
    const step = demUploadStep('/w', 6400);
    expect(step).toMatchObject({ localDir: join('/w', 'dem', 'terrarium'), prefix: 'dem/terrarium', objects: 6400 });
    expect(step.headers.contentType).toBe('image/png');
    expect(rcloneCommand(step, 'r2:fire-watch-tiles')).toContain("'r2:fire-watch-tiles/dem/terrarium'");
  });
});

describe('Terrarium PNG check', () => {
  it('accepts 256x256 8-bit RGB and RGBA', () => {
    expect(terrariumPngProblem(png())).toBeNull();
    expect(terrariumPngProblem(png(256, 256, 8, 6))).toBeNull();
  });

  it('names what is wrong with anything else', () => {
    expect(terrariumPngProblem(new TextEncoder().encode('<?xml version="1.0"?><Error>AccessDenied</Error>'))).toMatch(
      /signature/,
    );
    expect(terrariumPngProblem(png().subarray(0, 20))).toMatch(/too short/);
    expect(terrariumPngProblem(png(512, 512))).toMatch(/512×512/);
    expect(terrariumPngProblem(png(256, 256, 16))).toMatch(/bit depth 16/);
    expect(terrariumPngProblem(png(256, 256, 8, 0))).toMatch(/colour type 0/);
  });
});

describe('DEM manifest', () => {
  const tiers = demTiers([BG_BORDER], 2);

  it('round-trips through parse and summarizes by zoom', () => {
    const manifest = {
      ...emptyDemManifest(tiers, 2, new Date('2026-10-10T00:00:00Z')),
      tiles: {
        '0/0/0': { sha256: 'a'.repeat(64), bytes: 10, etag: '"x"', lastModified: null },
        '2/2/1': { sha256: 'b'.repeat(64), bytes: 5, etag: null, lastModified: null },
      },
    };
    expect(parseDemManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(summarizeDemManifest(manifest)).toEqual({ tiles: 2, bytes: 15, byZoom: { '0': 1, '2': 1 } });
  });

  it('rejects a manifest with a wrong format, tile id or hash', () => {
    const base = emptyDemManifest(tiers, 2, new Date(0));
    expect(() => parseDemManifest({ ...base, format: 'other' })).toThrow(/format/);
    expect(() => parseDemManifest({ ...base, tiles: { '0/0': { sha256: 'a'.repeat(64), bytes: 1 } } })).toThrow(
      /not z\/x\/y/,
    );
    expect(() => parseDemManifest({ ...base, tiles: { '0/0/0': { sha256: 'zz', bytes: 1 } } })).toThrow(/sha256/);
    expect(() => parseDemManifest({ ...base, tiles: { '0/0/0': { sha256: 'a'.repeat(64), bytes: 0 } } })).toThrow(
      /bytes/,
    );
    expect(base.format).toBe(DEM_MANIFEST_FORMAT);
  });

  it('resumes: a tile is present only with an entry and a file of the recorded size', () => {
    const tiles: TileCoord[] = [
      { z: 0, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 1, y: 1 },
    ];
    const manifest = {
      ...emptyDemManifest(tiers, 2, new Date(0)),
      tiles: {
        '0/0/0': { sha256: 'a'.repeat(64), bytes: 10, etag: null, lastModified: null },
        '1/1/0': { sha256: 'a'.repeat(64), bytes: 10, etag: null, lastModified: null },
        '9/9/9': { sha256: 'a'.repeat(64), bytes: 10, etag: null, lastModified: null },
      },
    };
    const sizes: Record<string, number> = { '0/0/0': 10, '1/1/0': 7, '1/1/1': 10 };
    const plan = planDemMirror(tiles, manifest, (t) => sizes[`${t.z}/${t.x}/${t.y}`] ?? null);
    expect(plan.present).toBe(1);
    expect(plan.fetch).toEqual([tiles[1], tiles[2]]);
    expect(plan.outsidePlan).toBe(1);
  });

  it('verify re-hashes every planned tile', () => {
    const good = png();
    const manifest = {
      ...emptyDemManifest(tiers, 2, new Date(0)),
      tiles: {
        '0/0/0': { sha256: sha256Hex(good), bytes: good.length, etag: null, lastModified: null },
        '1/0/0': { sha256: sha256Hex(good), bytes: good.length, etag: null, lastModified: null },
        '1/0/1': { sha256: sha256Hex(good), bytes: good.length, etag: null, lastModified: null },
      },
    };
    const disk: Record<string, Uint8Array> = { '0/0/0': good, '1/0/0': png(256, 256, 8, 2, 'IDAU') };
    const findings = verifyDemMirror(
      [
        { z: 0, x: 0, y: 0 },
        { z: 1, x: 0, y: 0 },
        { z: 1, x: 0, y: 1 },
        { z: 1, x: 1, y: 1 },
      ],
      manifest,
      (t) => disk[`${t.z}/${t.x}/${t.y}`] ?? null,
    );
    expect(findings).toEqual([
      { id: '1/0/0', problem: 'sha256 differs from the manifest' },
      { id: '1/0/1', problem: 'missing on disk' },
      { id: '1/1/1', problem: 'not in the manifest' },
    ]);
  });
});

describe('politeness', () => {
  it('spaces request starts across workers on the injected clock', () => {
    let t = 1000;
    const pacer = createPacer(4, () => t);
    expect([pacer.next(), pacer.next(), pacer.next()]).toEqual([0, 250, 500]);
    t = 2000;
    expect(pacer.next()).toBe(0);
    expect(() => createPacer(0, () => 0)).toThrow(RangeError);
    expect(() => createPacer(100, () => 0)).toThrow(RangeError);
  });

  it('retries network errors, 429 and 5xx with backoff; never 403/404', () => {
    expect(retryDelayMs(1, null, 4)).toBe(1000);
    expect(retryDelayMs(2, 503, 4)).toBe(2000);
    expect(retryDelayMs(3, 429, 4)).toBe(4000);
    expect(retryDelayMs(4, 503, 4)).toBeNull();
    expect(retryDelayMs(1, 404, 4)).toBeNull();
    expect(retryDelayMs(1, 403, 4)).toBeNull();
    expect(retryDelayMs(20, 500, 99)).toBe(30_000);
  });
});

describe('mirrorDem (injected network)', () => {
  const tiers = demTiers([BG_BORDER], 2);
  const tiles = [...enumerateTiles(tiers)];
  console.log("DBG", JSON.stringify(tiers), tiles.length);

  it('fetches, writes the bucket layout, records sha256 and resumes without refetching', async () => {
    const dir = work();
    const calls: string[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const fetchTile = (url: string): Promise<DemFetchResponse> => {
      calls.push(url);
      // The first request to 1/1/0 throttles once.
      if (url.endsWith('/1/1/0.png') && calls.filter((c) => c === url).length === 1) {
        return Promise.resolve({ status: 503, body: new Uint8Array(), etag: null, lastModified: null });
      }
      return Promise.resolve({ status: 200, body: png(256, 256, 8, 2, url), etag: '"e"', lastModified: 'then' });
    };
    const run = (manifest = emptyDemManifest(tiers, 2, new Date(0))) =>
      mirrorDem({
        workDir: dir,
        manifest,
        tiles: planDemMirror(tiles, manifest, demSizeOnDisk(dir)).fetch,
        fetchTile,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
        ratePerSecond: 10,
        concurrency: 2,
        checkpointEvery: 1,
      });

    const first = await run();
    expect(first.failed).toEqual([]);
    expect(first.fetched).toBe(tiles.length);
    expect(calls).toHaveLength(tiles.length + 1);
    expect(sleeps).toContain(1000);
    const onDisk = readFileSync(demTileFile(dir, { z: 1, x: 1, y: 0 }));
    expect(first.manifest.tiles['1/1/0']).toMatchObject({ sha256: sha256Hex(onDisk), etag: '"e"' });
    expect(existsSync(`${demTileFile(dir, { z: 1, x: 1, y: 0 })}.part`)).toBe(false);

    const stored = readDemManifest(dir);
    expect(stored).not.toBeNull();
    expect(Object.keys(stored?.tiles ?? {})).toEqual(Object.keys(stored?.tiles ?? {}).sort());

    calls.length = 0;
    const second = await run(stored ?? undefined);
    expect(second.fetched).toBe(0);
    expect(calls).toEqual([]);
    expect(verifyDemMirror(tiles, second.manifest, (t) => readFileSync(demTileFile(dir, t)))).toEqual([]);
  });

  it('reports a 404 and a 200 that is not a tile, and keeps going', async () => {
    const dir = work();
    mkdirSync(join(dir, 'dem'), { recursive: true });
    writeFileSync(join(dir, 'dem', 'keep'), '');
    const result = await mirrorDem({
      workDir: dir,
      manifest: emptyDemManifest(tiers, 2, new Date(0)),
      tiles,
      fetchTile: (url) =>
        Promise.resolve(
          url.endsWith('/0/0/0.png')
            ? { status: 404, body: new Uint8Array(), etag: null, lastModified: null }
            : url.endsWith('/1/1/0.png')
              ? { status: 200, body: new TextEncoder().encode('<Error/>'), etag: null, lastModified: null }
              : { status: 200, body: png(), etag: null, lastModified: null },
        ),
      sleep: () => Promise.resolve(),
      now: () => 0,
      ratePerSecond: 50,
      concurrency: 4,
    });
    expect(result.failed.map((f) => f.id).sort()).toEqual(['0/0/0', '1/1/0']);
    expect(result.failed.find((f) => f.id === '0/0/0')?.problem).toBe('HTTP 404 after 1 attempt(s)');
    expect(result.fetched).toBe(tiles.length - 2);
    expect(Object.keys(result.manifest.tiles)).not.toContain('0/0/0');
  });
});
