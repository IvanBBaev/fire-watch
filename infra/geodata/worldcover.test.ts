import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  CLASSES,
  SCALE,
  accumulateBlock,
  blockInGrid,
  cellAt,
  decodeBlock,
  fractionsAt,
  newCounts,
  parsePollingBbox,
  parseTiff,
  parseTileName,
  polygonClassCounts,
  polygonProductWeights,
  productGrid,
  quantize,
  readCounts,
  tileUrl,
  tilesFromGrid,
  type TiffInfo,
} from './worldcover.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------------
// A tiny WorldCover-shaped GeoTIFF, built in the test
// ---------------------------------------------------------------------------------

interface TagSpec {
  readonly tag: number;
  readonly type: 2 | 3 | 4 | 12;
  readonly values: readonly number[] | string;
}

interface TiffOptions {
  readonly width: number;
  readonly height: number;
  readonly tile: number;
  readonly originLon: number;
  readonly originLat: number;
  readonly pixels: Uint8Array;
  readonly compression?: number;
  readonly predictor?: number;
  readonly epsg?: number;
  readonly magic?: number;
  readonly pad?: number;
}

const SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 } as const;

function buildTiff(o: TiffOptions): Uint8Array {
  const across = Math.ceil(o.width / o.tile);
  const down = Math.ceil(o.height / o.tile);
  const blocks: Uint8Array[] = [];
  for (let ty = 0; ty < down; ty += 1) {
    for (let tx = 0; tx < across; tx += 1) {
      const block = new Uint8Array(o.tile * o.tile).fill(o.pad ?? 255);
      for (let r = 0; r < o.tile; r += 1) {
        for (let c = 0; c < o.tile; c += 1) {
          const y = ty * o.tile + r;
          const x = tx * o.tile + c;
          if (x < o.width && y < o.height) block[r * o.tile + c] = o.pixels[y * o.width + x] ?? 0;
        }
      }
      blocks.push((o.compression ?? 8) === 8 ? new Uint8Array(deflateSync(block)) : block);
    }
  }
  const tags: TagSpec[] = [
    { tag: 256, type: 4, values: [o.width] },
    { tag: 257, type: 4, values: [o.height] },
    { tag: 258, type: 3, values: [8] },
    { tag: 259, type: 3, values: [o.compression ?? 8] },
    { tag: 277, type: 3, values: [1] },
    { tag: 317, type: 3, values: [o.predictor ?? 1] },
    { tag: 322, type: 3, values: [o.tile] },
    { tag: 323, type: 3, values: [o.tile] },
    { tag: 324, type: 4, values: blocks.map(() => 0) }, // patched below
    { tag: 325, type: 4, values: blocks.map((b) => b.byteLength) },
    { tag: 33550, type: 12, values: [1 / 12000, 1 / 12000, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, o.originLon, o.originLat, 0] },
    {
      tag: 34735,
      type: 3,
      values: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, o.epsg ?? 4326],
    },
    { tag: 42113, type: 2, values: '0\0' },
  ];
  const ifdSize = 2 + tags.length * 12 + 4;
  const extra = tags.reduce((sum, t) => {
    const n = typeof t.values === 'string' ? t.values.length : t.values.length;
    const bytes = n * SIZE[t.type];
    return sum + (bytes > 4 ? bytes : 0);
  }, 0);
  const dataStart = 8 + ifdSize + extra;
  const total = dataStart + blocks.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949, false);
  view.setUint16(2, o.magic ?? 42, true);
  view.setUint32(4, 8, true);

  const offsets: number[] = [];
  let at = dataStart;
  for (const b of blocks) {
    offsets.push(at);
    out.set(b, at);
    at += b.byteLength;
  }
  view.setUint16(8, tags.length, true);
  let spill = 8 + ifdSize;
  tags.forEach((t, i) => {
    const values = t.tag === 324 ? offsets : t.values;
    const n = values.length;
    const base = 10 + i * 12;
    view.setUint16(base, t.tag, true);
    view.setUint16(base + 2, t.type, true);
    view.setUint32(base + 4, n, true);
    const bytes = n * SIZE[t.type];
    let where = base + 8;
    if (bytes > 4) {
      view.setUint32(base + 8, spill, true);
      where = spill;
      spill += bytes;
    }
    for (let k = 0; k < n; k += 1) {
      if (typeof values === 'string') view.setUint8(where + k, values.charCodeAt(k));
      else if (t.type === 3) view.setUint16(where + k * 2, values[k] ?? 0, true);
      else if (t.type === 4) view.setUint32(where + k * 4, values[k] ?? 0, true);
      else view.setFloat64(where + k * 8, values[k] ?? 0, true);
    }
  });
  return out;
}

/**
 * A 120×120 px image at 24° E, 42° N: exactly 2×2 product cells of 60 px. Cell NW is all
 * cropland, NE all tree cover, SW grassland over its top 20 rows and cropland below, SE
 * water with one built-up pixel. 64 px internal tiles, so the edge blocks carry padding
 * (255, not a class — reading it would throw).
 */
function sampleImage(): Uint8Array {
  const px = new Uint8Array(120 * 120);
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      let v: number;
      if (y < 60) v = x < 60 ? 40 : 10;
      else if (x < 60) v = y < 80 ? 30 : 40;
      else v = 80;
      px[y * 120 + x] = v;
    }
  }
  px[100 * 120 + 100] = 50;
  return px;
}

const GRID = productGrid({ west: 24, south: 41.99, east: 24.01, north: 42 });

function sampleTiff(over: Partial<TiffOptions> = {}): Uint8Array {
  return buildTiff({
    width: 120,
    height: 120,
    tile: 64,
    originLon: 24,
    originLat: 42,
    pixels: sampleImage(),
    ...over,
  });
}

function accumulateAll(bytes: Uint8Array, info: TiffInfo): Uint16Array {
  const counts = newCounts(GRID);
  for (let i = 0; i < info.tileOffsets.length; i += 1) {
    if (blockInGrid(info, i, GRID))
      accumulateBlock(counts, GRID, info, i, decodeBlock(bytes, info, i));
  }
  return counts;
}

const plane = (code: number): number => CLASSES.indexOf(code as (typeof CLASSES)[number]);

// ---------------------------------------------------------------------------------

describe('parsePollingBbox', () => {
  it('reads the real server config (drift guard: the CLI reads this same file)', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'server', 'src', 'core', 'config', 'polling-bbox.ts'),
      'utf8',
    );
    expect(parsePollingBbox(source)).toEqual({
      version: 'polling_bbox_v1',
      west: 20,
      south: 39,
      east: 31,
      north: 46,
    });
  });

  it('fails loudly when the declaration is not there', () => {
    expect(() => parsePollingBbox('export const X = 1;')).toThrow(/not found/);
  });

  it('rejects edges out of order', () => {
    const src =
      "defineConfig('polling_bbox', 'polling_bbox_v9', { west: 31, south: 39, east: 20, north: 46 })";
    expect(() => parsePollingBbox(src)).toThrow(/out of order/);
  });
});

describe('the tile grid', () => {
  it('names tiles by their lower-left corner', () => {
    expect(parseTileName('N42E024')).toEqual({ name: 'N42E024', lat: 42, lon: 24 });
    expect(parseTileName('S03W075')).toEqual({ name: 'S03W075', lat: -3, lon: -75 });
    expect(() => parseTileName('N42E24')).toThrow();
  });

  it('builds the S3 bucket URL', () => {
    expect(tileUrl('N42E024')).toBe(
      'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N42E024_Map.tif',
    );
  });

  it('keeps tiles that overlap the box with area, never ones that only touch it', () => {
    const grid = {
      features: ['N42E024', 'N39E018', 'N45E030', 'N36E024', 'N42E031', 'N42E021'].map(
        (ll_tile) => ({
          properties: { ll_tile },
        }),
      ),
    };
    const names = tilesFromGrid(grid, { west: 20, south: 39, east: 31, north: 46 }).map(
      (t) => t.name,
    );
    // N36E024 ends at 39° N and N42E031 starts at 31° E: edge contact only.
    expect(names).toEqual(['N39E018', 'N42E021', 'N42E024', 'N45E030']);
  });
});

describe('parseTiff', () => {
  it('reads the layout and georeference', () => {
    const info = parseTiff(sampleTiff());
    expect(info).toMatchObject({
      width: 120,
      height: 120,
      tileWidth: 64,
      tilesAcross: 2,
      tilesDown: 2,
      compression: 8,
      originLon: 24,
      originLat: 42,
      pixelsPerDegree: 12000,
      nodata: 0,
    });
    expect(info.tileOffsets).toHaveLength(4);
  });

  it('rejects what the minimal reader does not understand', () => {
    expect(() => parseTiff(sampleTiff({ magic: 43 }))).toThrow(/BigTIFF/);
    expect(() => parseTiff(sampleTiff({ compression: 5 }))).toThrow(/compression 5/);
    expect(() => parseTiff(sampleTiff({ predictor: 2 }))).toThrow(/predictor/);
    expect(() => parseTiff(sampleTiff({ epsg: 3035 }))).toThrow(/EPSG:4326/);
    const bigEndian = sampleTiff();
    bigEndian[0] = 0x4d;
    bigEndian[1] = 0x4d;
    expect(() => parseTiff(bigEndian)).toThrow(/little-endian/);
  });

  it('decodes deflate and uncompressed blocks to the same pixels', () => {
    const a = sampleTiff();
    const b = sampleTiff({ compression: 1 });
    expect(decodeBlock(a, parseTiff(a), 3)).toEqual(decodeBlock(b, parseTiff(b), 3));
  });
});

describe('accumulation and quantisation', () => {
  const bytes = sampleTiff();
  const info = parseTiff(bytes);
  const counts = accumulateAll(bytes, info);

  it('counts every pixel once and skips the block padding', () => {
    expect(counts.reduce((a, b) => a + b, 0)).toBe(120 * 120);
    const at = (cell: number, code: number): number =>
      counts[cell * CLASSES.length + plane(code)] ?? 0;
    expect(at(0, 40)).toBe(3600);
    expect(at(1, 10)).toBe(3600);
    expect(at(2, 30)).toBe(1200);
    expect(at(2, 40)).toBe(2400);
    expect(at(3, 80)).toBe(3599);
    expect(at(3, 50)).toBe(1);
  });

  it('quantises each cell to integers summing to 250, largest remainder first', () => {
    const product = quantize(counts, GRID);
    for (let cell = 0; cell < 4; cell += 1) {
      const shares = product.subarray(cell * CLASSES.length, (cell + 1) * CLASSES.length);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(SCALE);
    }
    const at = (cell: number, code: number): number =>
      product[cell * CLASSES.length + plane(code)] ?? 0;
    expect(at(2, 30)).toBe(83); // 83.33…
    expect(at(2, 40)).toBe(167); // 166.67… takes the spare unit
    expect(at(3, 80)).toBe(250); // 249.93 rounds up; 0.07 of built-up loses
    expect(at(3, 50)).toBe(0);
  });

  it('breaks an exact remainder tie toward the lower plane', () => {
    const grid = productGrid({ west: 0, south: 0, east: 0.005, north: 0.005 });
    const c = newCounts(grid);
    // 3 classes × 1200 px: 83.33 each, one spare unit, three equal remainders.
    c[plane(10)] = 1200;
    c[plane(20)] = 1200;
    c[plane(30)] = 1200;
    const q = quantize(c, grid);
    expect([q[plane(10)], q[plane(20)], q[plane(30)]]).toEqual([84, 83, 83]);
  });

  it('files a cell no tile covered as all no-data', () => {
    const grid = productGrid({ west: 0, south: 0, east: 0.005, north: 0.005 });
    expect(quantize(newCounts(grid), grid)[0]).toBe(SCALE);
  });

  it('throws on a pixel value that is not a class', () => {
    const px = sampleImage();
    px[5] = 41;
    const bad = sampleTiff({ pixels: px });
    const badInfo = parseTiff(bad);
    expect(() =>
      accumulateBlock(newCounts(GRID), GRID, badInfo, 0, decodeBlock(bad, badInfo, 0)),
    ).toThrow(/41 is not a WorldCover class/);
  });

  it('only adds the part of a tile inside the grid', () => {
    // The same image one cell further west: its eastern column of cells lands in the
    // grid's western column, the rest falls outside.
    const shifted = sampleTiff({ originLon: 24 - 0.005 });
    const shiftedInfo = parseTiff(shifted);
    const c = accumulateAll(shifted, shiftedInfo);
    expect(c.reduce((a, b) => a + b, 0)).toBe(2 * 3600);
    expect(c[0 * CLASSES.length + plane(10)]).toBe(3600);
  });
});

describe('lookups', () => {
  const bytes = sampleTiff();
  const info = parseTiff(bytes);
  const product = quantize(accumulateAll(bytes, info), GRID);

  it('finds the cell under a point and returns its shares', () => {
    expect(cellAt(GRID, 24.001, 41.999)).toBe(0);
    expect(cellAt(GRID, 24.009, 41.991)).toBe(3);
    expect(cellAt(GRID, 23.999, 41.999)).toBeNull();
    expect(fractionsAt(product, GRID, 24.002, 41.993)).toEqual({
      grassland: 0.332,
      cropland: 0.668,
    });
  });

  const source = (x: number, y: number): number => {
    const col = x - (24 + 180) * 12000;
    const row = y - (90 - 42) * 12000;
    return sampleImage()[row * 120 + col] ?? 0;
  };

  it('counts full-resolution pixels by centre inside the polygon', () => {
    // The western half of the image, exactly on pixel edges.
    const ring: [number, number][] = [
      [24, 41.99],
      [24.005, 41.99],
      [24.005, 42],
      [24, 42],
      [24, 41.99],
    ];
    const counts = polygonClassCounts([ring], source);
    expect(counts[plane(40)]).toBe(3600 + 2400);
    expect(counts[plane(30)]).toBe(1200);
    expect(readCounts(counts)).toMatchObject({
      cropland: 0.8333,
      grassland: 0.1667,
      crop_or_grass: 1,
      majority: 'cropland',
      cropland_ge_70: true,
    });
  });

  it('weights product cells by how much of them the polygon covers', () => {
    // The northern half of the image: cells 0 and 1 fully, nothing else.
    const ring: [number, number][] = [
      [24, 41.995],
      [24.01, 41.995],
      [24.01, 42],
      [24, 42],
      [24, 41.995],
    ];
    const { weights, cells } = polygonProductWeights(product, GRID, [ring]);
    expect(cells).toBe(2);
    const reading = readCounts(weights);
    expect(reading.cropland).toBe(0.5);
    expect(reading.tree_or_shrub).toBe(0.5);
    expect(reading.cropland_ge_70).toBe(false);
  });
});
