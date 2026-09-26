/**
 * A PMTiles v3 reader — enough to walk every tile of an extract and write it out as a
 * z/x/y tree (ADR-001 A1.1: PMTiles is the build format only; the bucket serves plain
 * objects so there is no range-request dependency at runtime).
 *
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md. Only what an
 * extract produced by `pmtiles extract` contains is supported: gzip or uncompressed
 * directories. A brotli/zstd archive is refused loudly rather than half-read.
 */

import { gunzipSync } from 'node:zlib';

import type { TileCoord } from './tile-plan.js';

export const HEADER_LENGTH = 127;

export type Compression = 'unknown' | 'none' | 'gzip' | 'brotli' | 'zstd';
const COMPRESSION: readonly Compression[] = ['unknown', 'none', 'gzip', 'brotli', 'zstd'];

export type TileType = 'unknown' | 'mvt' | 'png' | 'jpeg' | 'webp' | 'avif';
const TILE_TYPE: readonly TileType[] = ['unknown', 'mvt', 'png', 'jpeg', 'webp', 'avif'];

export interface PmtilesHeader {
  readonly rootDirectoryOffset: number;
  readonly rootDirectoryLength: number;
  readonly jsonMetadataOffset: number;
  readonly jsonMetadataLength: number;
  readonly leafDirectoryOffset: number;
  readonly leafDirectoryLength: number;
  readonly tileDataOffset: number;
  readonly tileDataLength: number;
  readonly addressedTilesCount: number;
  readonly tileEntriesCount: number;
  readonly tileContentsCount: number;
  readonly clustered: boolean;
  readonly internalCompression: Compression;
  readonly tileCompression: Compression;
  readonly tileType: TileType;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
  readonly centerZoom: number;
  readonly centerLon: number;
  readonly centerLat: number;
}

export interface DirectoryEntry {
  readonly tileId: number;
  readonly offset: number;
  readonly length: number;
  /** 0 = the entry points at a leaf directory, not at tile data. */
  readonly runLength: number;
}

function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('pmtiles: 64-bit field past 2^53');
  return Number(value);
}

export function parseHeader(bytes: Uint8Array): PmtilesHeader {
  if (bytes.length < HEADER_LENGTH) throw new RangeError('pmtiles: file shorter than the v3 header');
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== 'PMTiles') throw new RangeError('pmtiles: bad magic — not a PMTiles archive');
  if (bytes[7] !== 3) throw new RangeError(`pmtiles: spec version ${bytes[7]} is not 3`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_LENGTH);
  const e7 = (at: number): number => view.getInt32(at, true) / 1e7;
  return {
    rootDirectoryOffset: u64(view, 8),
    rootDirectoryLength: u64(view, 16),
    jsonMetadataOffset: u64(view, 24),
    jsonMetadataLength: u64(view, 32),
    leafDirectoryOffset: u64(view, 40),
    leafDirectoryLength: u64(view, 48),
    tileDataOffset: u64(view, 56),
    tileDataLength: u64(view, 64),
    addressedTilesCount: u64(view, 72),
    tileEntriesCount: u64(view, 80),
    tileContentsCount: u64(view, 88),
    clustered: view.getUint8(96) === 1,
    internalCompression: COMPRESSION[view.getUint8(97)] ?? 'unknown',
    tileCompression: COMPRESSION[view.getUint8(98)] ?? 'unknown',
    tileType: TILE_TYPE[view.getUint8(99)] ?? 'unknown',
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    minLon: e7(102),
    minLat: e7(106),
    maxLon: e7(110),
    maxLat: e7(114),
    centerZoom: view.getUint8(118),
    centerLon: e7(119),
    centerLat: e7(123),
  };
}

export function decompress(bytes: Uint8Array, compression: Compression): Uint8Array {
  switch (compression) {
    case 'none':
      return bytes;
    case 'gzip':
      return new Uint8Array(gunzipSync(bytes));
    default:
      throw new RangeError(
        `pmtiles: ${compression} compression is not supported — re-run pmtiles extract/convert with gzip`,
      );
  }
}

function readVarint(bytes: Uint8Array, state: { pos: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= bytes.length) throw new RangeError('pmtiles: truncated directory varint');
    const byte = bytes[state.pos++] ?? 0;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
}

/** Decodes one (already decompressed) directory. */
export function parseDirectory(bytes: Uint8Array): DirectoryEntry[] {
  const state = { pos: 0 };
  const count = readVarint(bytes, state);
  const tileIds: number[] = [];
  let lastId = 0;
  for (let i = 0; i < count; i += 1) {
    lastId += readVarint(bytes, state);
    tileIds.push(lastId);
  }
  const runLengths = Array.from({ length: count }, () => readVarint(bytes, state));
  const lengths = Array.from({ length: count }, () => readVarint(bytes, state));
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = readVarint(bytes, state);
    const previousOffset = offsets[i - 1];
    const previousLength = lengths[i - 1];
    if (raw === 0 && i > 0 && previousOffset !== undefined && previousLength !== undefined) {
      offsets.push(previousOffset + previousLength);
    } else {
      offsets.push(raw - 1);
    }
  }
  return tileIds.map((tileId, i) => ({
    tileId,
    runLength: runLengths[i] ?? 0,
    length: lengths[i] ?? 0,
    offset: offsets[i] ?? 0,
  }));
}

/** Encodes a directory — the inverse of `parseDirectory`, used by the test fixtures. */
export function serializeDirectory(entries: readonly DirectoryEntry[]): Uint8Array {
  const out: number[] = [];
  const push = (value: number): void => {
    let rest = value;
    while (rest >= 0x80) {
      out.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    out.push(rest);
  };
  push(entries.length);
  let lastId = 0;
  for (const entry of entries) {
    push(entry.tileId - lastId);
    lastId = entry.tileId;
  }
  for (const entry of entries) push(entry.runLength);
  for (const entry of entries) push(entry.length);
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    if (i > 0 && previous !== undefined && entry.offset === previous.offset + previous.length) push(0);
    else push(entry.offset + 1);
  });
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------
// Hilbert tile ids (spec §"Tile ID").

function rotate(n: number, xy: [number, number], rx: number, ry: number): void {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0];
      xy[1] = n - 1 - xy[1];
    }
    const t = xy[0];
    xy[0] = xy[1];
    xy[1] = t;
  }
}

/** Tiles in all zoom levels below `z`: (4^z − 1) / 3. */
function zoomBase(z: number): number {
  return (4 ** z - 1) / 3;
}

export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new RangeError('pmtiles: zoom above 26');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new RangeError(`pmtiles: tile ${z}/${x}/${y} out of range`);
  const xy: [number, number] = [x, y];
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return zoomBase(z) + d;
}

export function tileIdToZxy(tileId: number): TileCoord {
  let z = 0;
  while (z <= 26 && zoomBase(z + 1) <= tileId) z += 1;
  const n = 2 ** z;
  let t = tileId - zoomBase(z);
  const xy: [number, number] = [0, 0];
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    rotate(s, xy, rx, ry);
    xy[0] += s * rx;
    xy[1] += s * ry;
    t = Math.floor(t / 4);
  }
  return { z, x: xy[0], y: xy[1] };
}

// ---------------------------------------------------------------------------------------
// Walking an archive.

/** Random access to an archive; a file handle in the CLI, a buffer in the tests. */
export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    read: (offset, length) => {
      if (offset + length > bytes.length) return Promise.reject(new RangeError('pmtiles: read past end'));
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
}

export interface ArchiveTile {
  readonly tile: TileCoord;
  /** Stored bytes, still in `header.tileCompression` — exploded as-is. */
  readonly data: Uint8Array;
}

/**
 * Every addressed tile, in tile-id order. A run-length entry (one blob, several adjacent
 * ids — typically open sea) yields once per id, because the exploded tree has one object
 * per z/x/y. Leaf directories are followed recursively.
 */
export async function* readArchiveTiles(
  source: ByteSource,
): AsyncGenerator<ArchiveTile, void, undefined> {
  const header = parseHeader(await source.read(0, HEADER_LENGTH));
  if (header.tileType !== 'mvt') throw new RangeError(`pmtiles: tile type ${header.tileType}, expected mvt`);

  async function* walk(offset: number, length: number, depth: number): AsyncGenerator<ArchiveTile> {
    if (depth > 4) throw new RangeError('pmtiles: directory nesting deeper than 4');
    const raw = await source.read(offset, length);
    for (const entry of parseDirectory(decompress(raw, header.internalCompression))) {
      if (entry.runLength === 0) {
        yield* walk(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1);
        continue;
      }
      const data = await source.read(header.tileDataOffset + entry.offset, entry.length);
      for (let i = 0; i < entry.runLength; i += 1) {
        yield { tile: tileIdToZxy(entry.tileId + i), data };
      }
    }
  }

  yield* walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
}

export async function readMetadata(source: ByteSource): Promise<unknown> {
  const header = parseHeader(await source.read(0, HEADER_LENGTH));
  if (header.jsonMetadataLength === 0) return {};
  const raw = await source.read(header.jsonMetadataOffset, header.jsonMetadataLength);
  return JSON.parse(new TextDecoder().decode(decompress(raw, header.internalCompression))) as unknown;
}

// ---------------------------------------------------------------------------------------
// Writer — used by the tests to build tiny archives. Single root directory, no leaves.

export interface FixtureTile {
  readonly tile: TileCoord;
  readonly data: Uint8Array;
}

export function buildArchive(
  tiles: readonly FixtureTile[],
  options: { tileCompression?: Compression; internalCompression?: 'none' | 'gzip'; metadata?: unknown } = {},
  gzip: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
): Uint8Array {
  const internal = options.internalCompression ?? 'none';
  const pack = (bytes: Uint8Array): Uint8Array => (internal === 'gzip' ? gzip(bytes) : bytes);
  const sorted = [...tiles].sort(
    (a, b) => zxyToTileId(a.tile.z, a.tile.x, a.tile.y) - zxyToTileId(b.tile.z, b.tile.x, b.tile.y),
  );
  const entries: DirectoryEntry[] = [];
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const { tile, data } of sorted) {
    const tileId = zxyToTileId(tile.z, tile.x, tile.y);
    const previous = entries[entries.length - 1];
    const previousBlob = blobs[blobs.length - 1];
    if (
      previous !== undefined &&
      previousBlob !== undefined &&
      previous.tileId + previous.runLength === tileId &&
      Buffer.from(previousBlob).equals(Buffer.from(data))
    ) {
      entries[entries.length - 1] = { ...previous, runLength: previous.runLength + 1 };
      continue;
    }
    entries.push({ tileId, offset, length: data.length, runLength: 1 });
    blobs.push(data);
    offset += data.length;
  }
  const root = pack(serializeDirectory(entries));
  const metadata = pack(new TextEncoder().encode(JSON.stringify(options.metadata ?? {})));
  const tileData = Buffer.concat(blobs.map((blob) => Buffer.from(blob)));
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(new TextEncoder().encode('PMTiles'), 0);
  header[7] = 3;
  const view = new DataView(header.buffer);
  const set64 = (at: number, value: number): void => view.setBigUint64(at, BigInt(value), true);
  const rootOffset = HEADER_LENGTH;
  const metadataOffset = rootOffset + root.length;
  const tileDataOffset = metadataOffset + metadata.length;
  set64(8, rootOffset);
  set64(16, root.length);
  set64(24, metadataOffset);
  set64(32, metadata.length);
  set64(40, tileDataOffset);
  set64(48, 0);
  set64(56, tileDataOffset);
  set64(64, tileData.length);
  set64(72, sorted.length);
  set64(80, entries.length);
  set64(88, blobs.length);
  view.setUint8(96, 1);
  view.setUint8(97, COMPRESSION.indexOf(internal));
  view.setUint8(98, COMPRESSION.indexOf(options.tileCompression ?? 'gzip'));
  view.setUint8(99, 1);
  const zooms = sorted.map((entry) => entry.tile.z);
  view.setUint8(100, zooms.length === 0 ? 0 : Math.min(...zooms));
  view.setUint8(101, zooms.length === 0 ? 0 : Math.max(...zooms));
  return Buffer.concat([header, root, metadata, tileData]);
}
