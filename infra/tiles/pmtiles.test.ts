import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  buildArchive,
  bufferSource,
  type DirectoryEntry,
  parseDirectory,
  parseHeader,
  readArchiveTiles,
  readMetadata,
  serializeDirectory,
  tileIdToZxy,
  zxyToTileId,
} from './pmtiles.js';

const gzip = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));

async function collect(bytes: Uint8Array) {
  const out: Array<{ id: string; data: string }> = [];
  for await (const { tile, data } of readArchiveTiles(bufferSource(bytes))) {
    out.push({ id: `${tile.z}/${tile.x}/${tile.y}`, data: new TextDecoder().decode(data) });
  }
  return out;
}

describe('Hilbert tile ids (PMTiles v3 spec)', () => {
  it('matches the spec examples', () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    expect(zxyToTileId(1, 0, 0)).toBe(1);
    expect(zxyToTileId(1, 0, 1)).toBe(2);
    expect(zxyToTileId(1, 1, 1)).toBe(3);
    expect(zxyToTileId(1, 1, 0)).toBe(4);
    expect(zxyToTileId(2, 0, 0)).toBe(5);
  });

  it('round-trips every tile to z6 and a sample at z14', () => {
    for (let z = 0; z <= 6; z += 1) {
      const n = 2 ** z;
      const ids = new Set<number>();
      for (let x = 0; x < n; x += 1) {
        for (let y = 0; y < n; y += 1) {
          const id = zxyToTileId(z, x, y);
          ids.add(id);
          expect(tileIdToZxy(id)).toEqual({ z, x, y });
        }
      }
      expect(ids.size).toBe(n * n);
    }
    for (const [x, y] of [
      [9266, 6097],
      [0, 16383],
      [16383, 0],
    ] as const) {
      expect(tileIdToZxy(zxyToTileId(14, x, y))).toEqual({ z: 14, x, y });
    }
    expect(() => zxyToTileId(2, 4, 0)).toThrow(/out of range/);
  });
});

describe('directories', () => {
  it('round-trips entries including contiguous offsets and a leaf pointer', () => {
    const entries: DirectoryEntry[] = [
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 5, runLength: 3 },
      { tileId: 7, offset: 100, length: 7, runLength: 1 },
      { tileId: 40, offset: 0, length: 55, runLength: 0 },
    ];
    expect(parseDirectory(serializeDirectory(entries))).toEqual(entries);
  });
});

describe('reading an archive', () => {
  const tiles = [
    { tile: { z: 0, x: 0, y: 0 }, data: new TextEncoder().encode('world') },
    { tile: { z: 1, x: 1, y: 0 }, data: new TextEncoder().encode('ne') },
    { tile: { z: 1, x: 0, y: 0 }, data: new TextEncoder().encode('sea') },
    { tile: { z: 1, x: 0, y: 1 }, data: new TextEncoder().encode('sea') },
  ];

  it('parses the header the writer produced', () => {
    const header = parseHeader(buildArchive(tiles));
    expect(header.tileType).toBe('mvt');
    expect(header.tileCompression).toBe('gzip');
    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(1);
    // Two adjacent identical tiles collapse into one run-length entry.
    expect(header.tileEntriesCount).toBe(3);
    expect(header.addressedTilesCount).toBe(4);
  });

  it('yields every addressed tile once, expanding run lengths', async () => {
    const out = await collect(buildArchive(tiles));
    expect(out.map((entry) => entry.id).sort()).toEqual(['0/0/0', '1/0/0', '1/0/1', '1/1/0']);
    expect(out.find((entry) => entry.id === '1/0/1')?.data).toBe('sea');
  });

  it('reads gzip-compressed directories and metadata', async () => {
    const archive = buildArchive(tiles, { internalCompression: 'gzip', metadata: { name: 'fixture' } }, gzip);
    expect(parseHeader(archive).internalCompression).toBe('gzip');
    expect(await collect(archive)).toHaveLength(4);
    expect(await readMetadata(bufferSource(archive))).toEqual({ name: 'fixture' });
  });

  it('refuses what it cannot read rather than half-reading it', async () => {
    expect(() => parseHeader(new Uint8Array(200))).toThrow(/magic/);
    expect(() => parseHeader(new Uint8Array(10))).toThrow(/shorter/);
    const archive = buildArchive(tiles);
    archive[97] = 3; // brotli directories
    await expect(collect(archive)).rejects.toThrow(/brotli/);
    const raster = buildArchive(tiles);
    raster[99] = 2; // png
    await expect(collect(raster)).rejects.toThrow(/expected mvt/);
  });
});
