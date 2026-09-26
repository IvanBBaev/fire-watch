/**
 * PMTiles extract → z/x/y tree on disk (TASKS G1), plus the label scan the glyph build
 * needs (G2) — one pass over the archive does both.
 *
 * The tree is written exactly as the bucket will hold it under `tiles/<version>/`, so the
 * upload is a directory copy and what was verified locally is what is served. The stored
 * bytes are written untouched (still gzip); the upload stamps `Content-Encoding: gzip`.
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CodepointCollector } from './mvt-names.js';
import { type ByteSource, parseHeader, HEADER_LENGTH, readArchiveTiles, type PmtilesHeader } from './pmtiles.js';
import { type ExtractTier, MAX_TILE_ZOOM, tierCovers } from './tile-plan.js';

export interface ExplodeOptions {
  readonly source: ByteSource;
  readonly outDir: string;
  readonly labelFields: readonly string[];
  /** When given, a tile outside every tier is counted (a sign the extract used another bbox). */
  readonly tiers: readonly ExtractTier[] | null;
  /**
   * Tiles already written by an earlier extract into the same tree (tiers overlap: the
   * Balkans box sits inside the Europe box at z0–z8). A repeat is byte-identical — both
   * extracts cut the same planet build — so it is overwritten but counted once.
   */
  readonly seen?: Set<string>;
}

export interface ExplodeManifest {
  readonly tiles: number;
  readonly bytes: number;
  readonly byZoom: Record<string, number>;
  readonly outsideTiers: number;
  readonly tileCompression: PmtilesHeader['tileCompression'];
  readonly observedCodepoints: ReadonlyArray<{ readonly codepoint: number; readonly firstSeen: string }>;
}

export const MANIFEST_NAME = 'build-manifest.json';

export async function explode(options: ExplodeOptions): Promise<ExplodeManifest> {
  const header = parseHeader(await options.source.read(0, HEADER_LENGTH));
  if (header.maxZoom > MAX_TILE_ZOOM) {
    throw new RangeError(`extract max zoom ${header.maxZoom} exceeds z${MAX_TILE_ZOOM} (ADR-001 A1.1)`);
  }
  if (header.tileCompression !== 'gzip' && header.tileCompression !== 'none') {
    throw new RangeError(`tile compression ${header.tileCompression} cannot be served as-is`);
  }
  const collector = new CodepointCollector();
  const byZoom: Record<string, number> = {};
  let tiles = 0;
  let bytes = 0;
  let outsideTiers = 0;
  const madeDirs = new Set<string>();
  const seen = options.seen ?? new Set<string>();
  for await (const { tile, data } of readArchiveTiles(options.source)) {
    const id = `${tile.z}/${tile.x}/${tile.y}`;
    const path = join(options.outDir, String(tile.z), String(tile.x), `${tile.y}.mvt`);
    const dir = dirname(path);
    if (!madeDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      madeDirs.add(dir);
    }
    await writeFile(path, data);
    if (seen.has(id)) continue;
    seen.add(id);
    tiles += 1;
    bytes += data.length;
    byZoom[String(tile.z)] = (byZoom[String(tile.z)] ?? 0) + 1;
    if (options.tiers !== null && !tierCovers(options.tiers, tile)) outsideTiers += 1;
    collector.addTile(data, options.labelFields, id);
  }
  return {
    tiles,
    bytes,
    byZoom,
    outsideTiers,
    tileCompression: header.tileCompression,
    observedCodepoints: collector.entries(),
  };
}

/** Folds the manifests of several extracts exploded into one tree (`seen` shared). */
export function mergeManifests(manifests: readonly ExplodeManifest[]): ExplodeManifest {
  const first = manifests[0];
  if (first === undefined) throw new RangeError('no manifests to merge');
  const compressions = new Set(manifests.map((manifest) => manifest.tileCompression));
  if (compressions.size > 1) {
    // One tree is served with one Content-Encoding header; mixing would corrupt half of it.
    throw new RangeError(`extracts disagree on tile compression: ${[...compressions].join(', ')}`);
  }
  const byZoom: Record<string, number> = {};
  const codepoints = new Map<number, string>();
  for (const manifest of manifests) {
    for (const [z, count] of Object.entries(manifest.byZoom)) byZoom[z] = (byZoom[z] ?? 0) + count;
    for (const { codepoint, firstSeen } of manifest.observedCodepoints) {
      if (!codepoints.has(codepoint)) codepoints.set(codepoint, firstSeen);
    }
  }
  return {
    tiles: manifests.reduce((sum, manifest) => sum + manifest.tiles, 0),
    bytes: manifests.reduce((sum, manifest) => sum + manifest.bytes, 0),
    byZoom,
    outsideTiers: manifests.reduce((sum, manifest) => sum + manifest.outsideTiers, 0),
    tileCompression: first.tileCompression,
    observedCodepoints: [...codepoints.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([codepoint, firstSeen]) => ({ codepoint, firstSeen })),
  };
}

/** A read-only file handle as a `ByteSource`; `close()` when done. */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  return {
    read: async (offset, length) => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new RangeError(`pmtiles: short read at ${offset} (${bytesRead}/${length})`);
      return buffer;
    },
    close: () => handle.close(),
  };
}
