import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { localTilesResponse, resolveLocalTiles } from './dev-serve.js';

/** A work directory shaped like `build.sh` leaves it: two tile versions, one glyph build. */
function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'fire-watch-local-tiles-'));
  for (const version of ['20261003', '20261010']) {
    mkdirSync(join(root, 'tree', version, '9', '290', '190'), { recursive: true });
    writeFileSync(join(root, 'tree', version, '9', '290', '190.mvt'), gzipSync(Buffer.from(version)));
  }
  mkdirSync(join(root, 'fonts', '20261010', 'Noto Sans Regular'), { recursive: true });
  writeFileSync(join(root, 'fonts', '20261010', 'Noto Sans Regular', '768-1023.pbf'), Buffer.from([0x0a, 0x00]));
  writeFileSync(join(root, 'secret.txt'), 'outside the glyph tree');
  return root;
}

describe('local tile serving (TASKS G3)', () => {
  it('picks the newest version unless one is pinned, and fails loudly on an empty directory', () => {
    const root = workDir();
    expect(resolveLocalTiles(root)).toMatchObject({ tilesVersion: '20261010', glyphsVersion: '20261010' });
    expect(resolveLocalTiles(join(root), '20261010').tilesDir).toBe(join(root, 'tree', '20261010'));
    expect(() => resolveLocalTiles(join(root, 'nope'))).toThrow(/no tile tree/);
    expect(() => resolveLocalTiles(root, '20261003')).toThrow(/fonts.20261003 does not exist/);
  });

  it('serves a gzip-stored tile with the encoding the bucket would set', () => {
    const local = resolveLocalTiles(workDir());
    const response = localTilesResponse(local, '/tiles/9/290/190.mvt');
    expect(response?.status).toBe(200);
    expect(response?.headers['Content-Encoding']).toBe('gzip');
    expect(response?.headers['Content-Type']).toBe('application/vnd.mapbox-vector-tile');
  });

  it('answers 204 for a tile outside the extract, so MapLibre draws it empty', () => {
    const local = resolveLocalTiles(workDir());
    expect(localTilesResponse(local, '/tiles/14/1/1.mvt')).toMatchObject({ status: 204, body: null });
  });

  it('serves glyphs by URL-encoded fontstack and never leaves the glyph directory', () => {
    const local = resolveLocalTiles(workDir());
    expect(localTilesResponse(local, '/fonts/Noto%20Sans%20Regular/768-1023.pbf')?.status).toBe(200);
    expect(localTilesResponse(local, '/fonts/Noto%20Sans%20Bold/768-1023.pbf')?.status).toBe(404);
    expect(localTilesResponse(local, '/fonts/..%2F..%2F..%2Fsecret/0-255.pbf')?.status).toBe(404);
    expect(localTilesResponse(local, '/fonts/%E0%A4%A/0-255.pbf')?.status).toBe(400);
    expect(localTilesResponse(local, '/other/thing')).toBeNull();
  });
});
