/**
 * Land-cover prep from ESA WorldCover 10 m 2021 v200 (TASKS D10, land-cover half).
 *
 * Pure functions only — no network, no file system — so every step that decides a byte
 * of the derived product is unit-tested on tiny fixtures. `worldcover-cli.ts` does the
 * fetching, hashing and file writing.
 *
 * The source is a set of 3°×3° Cloud-Optimised GeoTIFFs in EPSG:4326 at 1/12000° per
 * pixel, one byte per pixel holding a class code (10 tree cover … 100 moss and lichen,
 * 0 no data). This module reads exactly that layout with a minimal TIFF reader
 * (`node:zlib` for deflate), not a general GeoTIFF library: anything outside the layout
 * — BigTIFF, another compression, a predictor, a second band, another CRS — is rejected
 * rather than guessed at.
 *
 * The derived product is a grid of 0.005° cells over the polling box. Each cell holds
 * the share of its 60×60 source pixels in each class, quantised to 1/250 so the twelve
 * shares of a cell are integers that sum to exactly 250. 0.005° (~555 m × ~410 m at
 * 42° N) is near the 375 m VIIRS I-band pixel, divides the source grid exactly, and
 * nests in the 0.01° hot-source mask grid (F16).
 */

import { inflateSync } from 'node:zlib';

export const FORMAT = 'fire-watch/worldcover-landcover@1';

/** Source epoch + version + grid step; changes whenever any of them changes. */
export const PRODUCT_VERSION = 'worldcover_2021_v200_0p005';

export const SOURCE_BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021';
export const GRID_URL = `${SOURCE_BASE}/esa_worldcover_grid.geojson`;

/** Source pixels per degree (pixel size 1/12000°, ~8.3 m of latitude). */
export const PIXELS_PER_DEGREE = 12000;

/** Source pixels per product cell edge: 60 px = 0.005°. */
export const CELL_PIXELS = 60;

/** The quantisation: the twelve shares of a cell are integers summing to this. */
export const SCALE = 250;

/** WorldCover class codes in plane order. 0 is no data. */
export const CLASSES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100] as const;
export type ClassCode = (typeof CLASSES)[number];

export const CLASS_NAMES: Readonly<Record<ClassCode, string>> = {
  0: 'no_data',
  10: 'tree_cover',
  20: 'shrubland',
  30: 'grassland',
  40: 'cropland',
  50: 'built_up',
  60: 'bare_sparse',
  70: 'snow_ice',
  80: 'permanent_water',
  90: 'herbaceous_wetland',
  95: 'mangroves',
  100: 'moss_lichen',
};

const PLANE_OF = new Int8Array(256).fill(-1);
CLASSES.forEach((code, plane) => {
  PLANE_OF[code] = plane;
});

export function tileUrl(name: string): string {
  return `${SOURCE_BASE}/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
}

export function tileFileName(name: string): string {
  return `ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
}

// ---------------------------------------------------------------------------------
// The polling box, read from the server config source
// ---------------------------------------------------------------------------------

export interface Bbox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface VersionedBbox extends Bbox {
  readonly version: string;
}

/**
 * `infra/geodata` imports only Node built-ins, so it cannot import the server's
 * `POLLING_BBOX`. It reads the config's source text instead and fails loudly if the
 * declaration no longer has the shape this parser knows — never a silent fallback box.
 */
export function parsePollingBbox(source: string): VersionedBbox {
  const match =
    /defineConfig\(\s*'polling_bbox',\s*'([a-z0-9_]+)',\s*\{\s*west:\s*(-?[\d.]+),\s*south:\s*(-?[\d.]+),\s*east:\s*(-?[\d.]+),\s*north:\s*(-?[\d.]+),?\s*\}/.exec(
      source,
    );
  if (!match) throw new Error('polling_bbox declaration not found in the config source');
  const [, version, w, s, e, n] = match;
  const box = {
    version: version ?? '',
    west: Number(w),
    south: Number(s),
    east: Number(e),
    north: Number(n),
  };
  if (![box.west, box.south, box.east, box.north].every(Number.isFinite)) {
    throw new Error('polling_bbox has a non-numeric edge');
  }
  if (box.west >= box.east || box.south >= box.north) {
    throw new Error('polling_bbox edges are out of order');
  }
  return box;
}

// ---------------------------------------------------------------------------------
// The tile grid
// ---------------------------------------------------------------------------------

export interface TileName {
  readonly name: string;
  /** Lower-left corner, whole degrees. */
  readonly lon: number;
  readonly lat: number;
}

export function parseTileName(name: string): TileName {
  const match = /^([NS])(\d{2})([EW])(\d{3})$/.exec(name);
  if (!match) throw new Error(`not a WorldCover tile name: ${name}`);
  const [, ns, lat, ew, lon] = match;
  return {
    name,
    lat: (ns === 'S' ? -1 : 1) * Number(lat),
    lon: (ew === 'W' ? -1 : 1) * Number(lon),
  };
}

export interface GridCollection {
  readonly features: readonly { readonly properties?: Record<string, unknown> | null }[];
}

/**
 * The tiles of the published grid whose 3°×3° square overlaps the box with positive area,
 * sorted by name. A square the grid does not list (open sea) is not fetched.
 */
export function tilesFromGrid(grid: GridCollection, bbox: Bbox): TileName[] {
  const tiles: TileName[] = [];
  for (const feature of grid.features) {
    const name = feature.properties?.['ll_tile'];
    if (typeof name !== 'string') continue;
    const tile = parseTileName(name);
    if (
      tile.lon < bbox.east &&
      tile.lon + 3 > bbox.west &&
      tile.lat < bbox.north &&
      tile.lat + 3 > bbox.south
    ) {
      tiles.push(tile);
    }
  }
  return tiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------
// The minimal TIFF reader
// ---------------------------------------------------------------------------------

export interface TiffInfo {
  readonly width: number;
  readonly height: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesAcross: number;
  readonly tilesDown: number;
  readonly compression: 1 | 8;
  readonly tileOffsets: readonly number[];
  readonly tileByteCounts: readonly number[];
  /** Top-left corner of the top-left pixel, degrees. */
  readonly originLon: number;
  readonly originLat: number;
  /** Pixels per degree on both axes (square pixels are required). */
  readonly pixelsPerDegree: number;
  /** `GDAL_NODATA`, or null when the file declares none. */
  readonly nodata: number | null;
}

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

interface Entry {
  readonly type: number;
  readonly count: number;
  readonly at: number;
}

/** Reads IFD0 of a classic little-endian TIFF laid out as WorldCover publishes it. */
export function parseTiff(bytes: Uint8Array): TiffInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8) throw new Error('TIFF: truncated header');
  if (view.getUint16(0, false) !== 0x4949) throw new Error('TIFF: only little-endian is supported');
  const magic = view.getUint16(2, true);
  if (magic === 43) throw new Error('TIFF: BigTIFF is not supported');
  if (magic !== 42) throw new Error('TIFF: bad magic');

  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i += 1) {
    const base = ifd + 2 + i * 12;
    const tag = view.getUint16(base, true);
    const type = view.getUint16(base + 2, true);
    const n = view.getUint32(base + 4, true);
    const size = TYPE_SIZE[type];
    if (size === undefined) continue; // a tag type this reader never needs
    const at = size * n <= 4 ? base + 8 : view.getUint32(base + 8, true);
    entries.set(tag, { type, count: n, at });
  }

  const numbers = (tag: number): number[] => {
    const entry = entries.get(tag);
    if (!entry) throw new Error(`TIFF: missing tag ${String(tag)}`);
    const out: number[] = [];
    for (let i = 0; i < entry.count; i += 1) {
      if (entry.type === 3) out.push(view.getUint16(entry.at + i * 2, true));
      else if (entry.type === 4) out.push(view.getUint32(entry.at + i * 4, true));
      else if (entry.type === 12) out.push(view.getFloat64(entry.at + i * 8, true));
      else if (entry.type === 1) out.push(view.getUint8(entry.at + i));
      else throw new Error(`TIFF: tag ${String(tag)} is not numeric`);
    }
    return out;
  };
  const one = (tag: number, fallback?: number): number => {
    if (!entries.has(tag) && fallback !== undefined) return fallback;
    const value = numbers(tag)[0];
    if (value === undefined) throw new Error(`TIFF: empty tag ${String(tag)}`);
    return value;
  };

  const width = one(256);
  const height = one(257);
  if (one(258) !== 8) throw new Error('TIFF: only 8-bit samples are supported');
  const compression = one(259, 1);
  if (compression !== 1 && compression !== 8) {
    throw new Error(`TIFF: compression ${String(compression)} is not supported`);
  }
  if (one(277, 1) !== 1) throw new Error('TIFF: only single-band images are supported');
  if (one(317, 1) !== 1) throw new Error('TIFF: a predictor is not supported');
  if (!entries.has(322)) throw new Error('TIFF: only tiled images are supported');
  const tileWidth = one(322);
  const tileHeight = one(323);
  const tileOffsets = numbers(324);
  const tileByteCounts = numbers(325);
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  if (
    tileOffsets.length !== tilesAcross * tilesDown ||
    tileByteCounts.length !== tileOffsets.length
  ) {
    throw new Error('TIFF: tile tables do not match the image size');
  }

  // GeoTIFF: geographic model, WGS 84, pixel-is-area.
  const geoKeys = numbers(34735);
  const keyCount = geoKeys[3] ?? 0;
  const keys = new Map<number, number>();
  for (let k = 0; k < keyCount; k += 1) {
    const id = geoKeys[4 + k * 4];
    const location = geoKeys[5 + k * 4];
    const value = geoKeys[7 + k * 4];
    if (id !== undefined && location === 0 && value !== undefined) keys.set(id, value);
  }
  if (keys.get(1024) !== 2) throw new Error('TIFF: not a geographic model (GTModelTypeGeoKey)');
  if (keys.get(2048) !== 4326) throw new Error('TIFF: CRS is not EPSG:4326');
  if (keys.has(1025) && keys.get(1025) !== 1) throw new Error('TIFF: raster is not pixel-is-area');

  const [scaleX, scaleY] = numbers(33550);
  const tie = numbers(33922);
  if (scaleX === undefined || scaleY === undefined || tie.length < 6) {
    throw new Error('TIFF: missing georeference');
  }
  if (tie[0] !== 0 || tie[1] !== 0) throw new Error('TIFF: tiepoint is not at pixel (0, 0)');
  const pixelsPerDegree = Math.round(1 / scaleX);
  if (
    Math.abs(1 / scaleX - pixelsPerDegree) > 1e-6 ||
    Math.abs(1 / scaleY - pixelsPerDegree) > 1e-6
  ) {
    throw new Error('TIFF: pixels are not square at a whole number per degree');
  }

  let nodata: number | null = null;
  const nodataEntry = entries.get(42113);
  if (nodataEntry) {
    const raw = new TextDecoder()
      .decode(bytes.subarray(nodataEntry.at, nodataEntry.at + nodataEntry.count))
      .replace(/\0+$/, '')
      .trim();
    nodata = raw === '' ? null : Number(raw);
  }

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    tilesAcross,
    tilesDown,
    compression,
    tileOffsets,
    tileByteCounts,
    originLon: tie[3] ?? 0,
    originLat: tie[4] ?? 0,
    pixelsPerDegree,
    nodata,
  };
}

/** One internal tile ("block") as `tileWidth × tileHeight` bytes, padding included. */
export function decodeBlock(bytes: Uint8Array, info: TiffInfo, index: number): Uint8Array {
  const offset = info.tileOffsets[index];
  const length = info.tileByteCounts[index];
  if (offset === undefined || length === undefined)
    throw new Error(`TIFF: no block ${String(index)}`);
  const raw = bytes.subarray(offset, offset + length);
  const out = info.compression === 8 ? new Uint8Array(inflateSync(raw)) : raw;
  if (out.byteLength !== info.tileWidth * info.tileHeight) {
    throw new Error(`TIFF: block ${String(index)} decodes to ${String(out.byteLength)} bytes`);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// The product grid and accumulation
// ---------------------------------------------------------------------------------

/**
 * The product grid. Row 0 is the northern edge, column 0 the western one. Pixel
 * coordinates are global: x counts source pixels east of 180° W, y south of 90° N, so a
 * tile and the grid line up by integer arithmetic only.
 */
export interface ProductGrid {
  readonly west: number;
  readonly north: number;
  readonly cols: number;
  readonly rows: number;
  /** Global pixel x of the grid's western edge, y of its northern edge. */
  readonly x0: number;
  readonly y0: number;
}

export function productGrid(bbox: Bbox): ProductGrid {
  const step = CELL_PIXELS / PIXELS_PER_DEGREE;
  const cols = (bbox.east - bbox.west) / step;
  const rows = (bbox.north - bbox.south) / step;
  if (Math.abs(cols - Math.round(cols)) > 1e-9 || Math.abs(rows - Math.round(rows)) > 1e-9) {
    throw new Error('the box is not a whole number of cells');
  }
  const x0 = (bbox.west + 180) * PIXELS_PER_DEGREE;
  const y0 = (90 - bbox.north) * PIXELS_PER_DEGREE;
  if (
    !Number.isInteger(Math.round(x0 * 1e6) / 1e6) ||
    !Number.isInteger(Math.round(y0 * 1e6) / 1e6)
  ) {
    throw new Error('the box edges do not fall on source pixel edges');
  }
  return {
    west: bbox.west,
    north: bbox.north,
    cols: Math.round(cols),
    rows: Math.round(rows),
    x0: Math.round(x0),
    y0: Math.round(y0),
  };
}

/** Per-cell, per-class pixel counts: `counts[cell * CLASSES.length + plane]`. */
export function newCounts(grid: ProductGrid): Uint16Array {
  return new Uint16Array(grid.cols * grid.rows * CLASSES.length);
}

/** Global pixel position of a tile's top-left pixel, checked to be on the grid. */
export function tileOriginPixels(info: TiffInfo): { readonly x: number; readonly y: number } {
  if (info.pixelsPerDegree !== PIXELS_PER_DEGREE) {
    throw new Error(
      `source has ${String(info.pixelsPerDegree)} px/°, expected ${String(PIXELS_PER_DEGREE)}`,
    );
  }
  const x = (info.originLon + 180) * PIXELS_PER_DEGREE;
  const y = (90 - info.originLat) * PIXELS_PER_DEGREE;
  if (Math.abs(x - Math.round(x)) > 1e-6 || Math.abs(y - Math.round(y)) > 1e-6) {
    throw new Error('tile origin is not on a source pixel edge');
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** Does block `index` of the tile overlap the grid at all? */
export function blockInGrid(info: TiffInfo, index: number, grid: ProductGrid): boolean {
  const origin = tileOriginPixels(info);
  const bx = origin.x + (index % info.tilesAcross) * info.tileWidth;
  const by = origin.y + Math.floor(index / info.tilesAcross) * info.tileHeight;
  return (
    bx < grid.x0 + grid.cols * CELL_PIXELS &&
    bx + info.tileWidth > grid.x0 &&
    by < grid.y0 + grid.rows * CELL_PIXELS &&
    by + info.tileHeight > grid.y0
  );
}

/**
 * Adds the pixels of one decoded block to the counts. Padding beyond the image edge and
 * pixels outside the grid are skipped; a value that is not a WorldCover class throws.
 */
export function accumulateBlock(
  counts: Uint16Array,
  grid: ProductGrid,
  info: TiffInfo,
  index: number,
  block: Uint8Array,
): void {
  const origin = tileOriginPixels(info);
  const col0 = (index % info.tilesAcross) * info.tileWidth;
  const row0 = Math.floor(index / info.tilesAcross) * info.tileHeight;
  const planes = CLASSES.length;
  const gridW = grid.cols * CELL_PIXELS;
  const gridH = grid.rows * CELL_PIXELS;
  for (let r = 0; r < info.tileHeight; r += 1) {
    const imageRow = row0 + r;
    if (imageRow >= info.height) break;
    const gy = origin.y + imageRow - grid.y0;
    if (gy < 0 || gy >= gridH) continue;
    const cellRowBase = Math.floor(gy / CELL_PIXELS) * grid.cols;
    const line = r * info.tileWidth;
    for (let c = 0; c < info.tileWidth; c += 1) {
      const imageCol = col0 + c;
      if (imageCol >= info.width) break;
      const gx = origin.x + imageCol - grid.x0;
      if (gx < 0 || gx >= gridW) continue;
      const value = block[line + c] ?? 0;
      const plane = PLANE_OF[value] ?? -1;
      if (plane < 0) throw new Error(`pixel value ${String(value)} is not a WorldCover class`);
      const at = (cellRowBase + Math.floor(gx / CELL_PIXELS)) * planes + plane;
      counts[at] = (counts[at] ?? 0) + 1;
    }
  }
}

/**
 * Twelve shares per cell, integers summing to `SCALE`, by largest remainder (ties to the
 * lower plane). A cell no tile covered — open sea where the grid publishes no tile —
 * is all no-data. Output layout: `product[cell * 12 + plane]`, cell-major.
 */
export function quantize(counts: Uint16Array, grid: ProductGrid): Uint8Array {
  const planes = CLASSES.length;
  const cells = grid.cols * grid.rows;
  const out = new Uint8Array(cells * planes);
  const remainders = new Array<number>(planes);
  const order = Array.from({ length: planes }, (_, i) => i);
  for (let cell = 0; cell < cells; cell += 1) {
    const base = cell * planes;
    let total = 0;
    for (let p = 0; p < planes; p += 1) total += counts[base + p] ?? 0;
    if (total === 0) {
      out[base] = SCALE;
      continue;
    }
    let assigned = 0;
    for (let p = 0; p < planes; p += 1) {
      const scaled = (counts[base + p] ?? 0) * SCALE;
      const q = Math.floor(scaled / total);
      out[base + p] = q;
      assigned += q;
      remainders[p] = scaled - q * total;
    }
    let left = SCALE - assigned;
    if (left > 0) {
      order.sort((a, b) => (remainders[b] ?? 0) - (remainders[a] ?? 0) || a - b);
      for (const p of order) {
        if (left === 0) break;
        out[base + p] = (out[base + p] ?? 0) + 1;
        left -= 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------

export type Fractions = Readonly<Record<string, number>>;

function named(values: readonly number[], total: number): Fractions {
  const out: Record<string, number> = {};
  CLASSES.forEach((code, plane) => {
    const v = values[plane] ?? 0;
    if (v > 0) out[CLASS_NAMES[code]] = total === 0 ? 0 : Math.round((v / total) * 10000) / 10000;
  });
  return out;
}

/** The cell holding a point, or null outside the grid. A point on an edge goes east/south. */
export function cellAt(grid: ProductGrid, lon: number, lat: number): number | null {
  const step = CELL_PIXELS / PIXELS_PER_DEGREE;
  const col = Math.floor((lon - grid.west) / step);
  const row = Math.floor((grid.north - lat) / step);
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  return row * grid.cols + col;
}

/** Class shares (0–1, rounded to 1e-4, zero classes omitted) of the cell under a point. */
export function fractionsAt(
  product: Uint8Array,
  grid: ProductGrid,
  lon: number,
  lat: number,
): Fractions | null {
  const cell = cellAt(grid, lon, lat);
  if (cell === null) return null;
  const planes = CLASSES.length;
  return named(Array.from(product.subarray(cell * planes, (cell + 1) * planes)), SCALE);
}

type LonLat = readonly [number, number];
type Ring = readonly LonLat[];

/** Even-odd test against every outer ring (rings are never holes here). */
export function insideRings(rings: readonly Ring[], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      if (!a || !b) continue;
      if (
        a[1] > lat !== b[1] > lat &&
        lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function ringsBox(rings: readonly Ring[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  return [w, s, e, n];
}

/** Reads one source pixel by global pixel position; the CLI backs it with a block cache. */
export type PixelSource = (x: number, y: number) => number;

/**
 * Full-resolution class counts under a polygon: every source pixel whose centre lies
 * inside any outer ring. This is the reference the coarse product is judged against.
 */
export function polygonClassCounts(rings: readonly Ring[], source: PixelSource): number[] {
  const counts = new Array<number>(CLASSES.length).fill(0);
  const [w, s, e, n] = ringsBox(rings);
  const x0 = Math.floor((w + 180) * PIXELS_PER_DEGREE);
  const x1 = Math.ceil((e + 180) * PIXELS_PER_DEGREE);
  const y0 = Math.floor((90 - n) * PIXELS_PER_DEGREE);
  const y1 = Math.ceil((90 - s) * PIXELS_PER_DEGREE);
  for (let y = y0; y < y1; y += 1) {
    const lat = 90 - (y + 0.5) / PIXELS_PER_DEGREE;
    for (let x = x0; x < x1; x += 1) {
      const lon = (x + 0.5) / PIXELS_PER_DEGREE - 180;
      if (!insideRings(rings, lon, lat)) continue;
      const value = source(x, y);
      const plane = PLANE_OF[value] ?? -1;
      if (plane < 0) throw new Error(`pixel value ${String(value)} is not a WorldCover class`);
      counts[plane] = (counts[plane] ?? 0) + 1;
    }
  }
  return counts;
}

/** Sub-samples per cell edge used to weight a cell by how much of it a polygon covers. */
export const POLYGON_SUBSAMPLES = 10;

/**
 * What the coarse product says under a polygon: each touched cell's shares weighted by
 * the fraction of a 10×10 lattice of its points inside the polygon. Returned as summed
 * weights per plane (not normalised) so a caller can report the coverage it rests on.
 */
export function polygonProductWeights(
  product: Uint8Array,
  grid: ProductGrid,
  rings: readonly Ring[],
): { readonly weights: number[]; readonly cells: number } {
  const planes = CLASSES.length;
  const step = CELL_PIXELS / PIXELS_PER_DEGREE;
  const weights = new Array<number>(planes).fill(0);
  const [w, s, e, n] = ringsBox(rings);
  const c0 = Math.max(0, Math.floor((w - grid.west) / step));
  const c1 = Math.min(grid.cols - 1, Math.floor((e - grid.west) / step));
  const r0 = Math.max(0, Math.floor((grid.north - n) / step));
  const r1 = Math.min(grid.rows - 1, Math.floor((grid.north - s) / step));
  let cells = 0;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      let hits = 0;
      for (let i = 0; i < POLYGON_SUBSAMPLES; i += 1) {
        const lat = grid.north - (r + (i + 0.5) / POLYGON_SUBSAMPLES) * step;
        for (let j = 0; j < POLYGON_SUBSAMPLES; j += 1) {
          const lon = grid.west + (c + (j + 0.5) / POLYGON_SUBSAMPLES) * step;
          if (insideRings(rings, lon, lat)) hits += 1;
        }
      }
      if (hits === 0) continue;
      cells += 1;
      const weight = hits / (POLYGON_SUBSAMPLES * POLYGON_SUBSAMPLES);
      const base = (r * grid.cols + c) * planes;
      for (let p = 0; p < planes; p += 1) {
        weights[p] = (weights[p] ?? 0) + weight * ((product[base + p] ?? 0) / SCALE);
      }
    }
  }
  return { weights, cells };
}

// ---------------------------------------------------------------------------------
// Reading counts as land-cover verdicts
// ---------------------------------------------------------------------------------

export interface LandCoverReading {
  readonly fractions: Fractions;
  readonly cropland: number;
  readonly grassland: number;
  readonly crop_or_grass: number;
  readonly tree_or_shrub: number;
  readonly majority: string;
  /** A6 `likely_agri_burn` threshold: at least 70 % of the area on WorldCover 40. */
  readonly cropland_ge_70: boolean;
}

export function readCounts(values: readonly number[]): LandCoverReading {
  const total = values.reduce((a, b) => a + b, 0);
  const share = (code: ClassCode): number => {
    const v = values[CLASSES.indexOf(code)] ?? 0;
    return total === 0 ? 0 : v / total;
  };
  const round = (x: number): number => Math.round(x * 10000) / 10000;
  let best = 0;
  values.forEach((v, p) => {
    if (v > (values[best] ?? 0)) best = p;
  });
  const cropland = share(40);
  return {
    fractions: named(values, total),
    cropland: round(cropland),
    grassland: round(share(30)),
    crop_or_grass: round(cropland + share(30)),
    tree_or_shrub: round(share(10) + share(20)),
    majority: CLASS_NAMES[CLASSES[best] ?? 0],
    cropland_ge_70: cropland >= 0.7,
  };
}
