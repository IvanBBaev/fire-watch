import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { explode, mergeManifests } from './explode.js';
import { buildArchive, bufferSource } from './pmtiles.js';
import type { ExtractTier } from './tile-plan.js';
import { encodeMvt } from './test-support.js';

const LABEL_FIELDS = ['name:bg', 'name'];
const gz = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fw-tiles-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

const world: ExtractTier = {
  name: 'world',
  bbox: { west: -180, south: -85, east: 180, north: 85 },
  minzoom: 0,
  maxzoom: 1,
};

describe('explode', () => {
  it('writes a z/x/y tree of the stored bytes and a manifest with label codepoints', async () => {
    const greek = gz(encodeMvt([{ name: 'places', features: [{ name: 'Σέρρες' }] }]));
    const empty = gz(encodeMvt([]));
    const archive = buildArchive([
      { tile: { z: 0, x: 0, y: 0 }, data: greek },
      { tile: { z: 1, x: 0, y: 0 }, data: empty },
      { tile: { z: 1, x: 0, y: 1 }, data: empty },
      { tile: { z: 1, x: 1, y: 1 }, data: empty },
      { tile: { z: 1, x: 1, y: 0 }, data: empty },
    ]);
    const out = tempDir();
    const manifest = await explode({ source: bufferSource(archive), outDir: out, labelFields: LABEL_FIELDS, tiers: [world] });
    expect(listTree(out)).toEqual(['0/0/0.mvt', '1/0/0.mvt', '1/0/1.mvt', '1/1/0.mvt', '1/1/1.mvt']);
    // Bytes are written as stored — still gzip, served with Content-Encoding: gzip.
    expect(new Uint8Array(readFileSync(join(out, '0/0/0.mvt')))).toEqual(greek);
    expect(manifest.tiles).toBe(5);
    expect(manifest.byZoom).toEqual({ '0': 1, '1': 4 });
    expect(manifest.outsideTiers).toBe(0);
    expect(manifest.tileCompression).toBe('gzip');
    const expected = [...new Set('Σέρρες')].map((c) => c.codePointAt(0)).sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(manifest.observedCodepoints.map((entry) => entry.codepoint)).toEqual(expected);
  });

  it('counts overlapping extracts once and flags tiles outside every tier', async () => {
    const tile = gz(encodeMvt([]));
    const a = buildArchive([{ tile: { z: 0, x: 0, y: 0 }, data: tile }, { tile: { z: 1, x: 1, y: 1 }, data: tile }]);
    const b = buildArchive([{ tile: { z: 0, x: 0, y: 0 }, data: tile }, { tile: { z: 2, x: 3, y: 3 }, data: tile }]);
    const out = tempDir();
    const seen = new Set<string>();
    const first = await explode({ source: bufferSource(a), outDir: out, labelFields: LABEL_FIELDS, tiers: [world], seen });
    const second = await explode({ source: bufferSource(b), outDir: out, labelFields: LABEL_FIELDS, tiers: [world], seen });
    const merged = mergeManifests([first, second]);
    expect(merged.tiles).toBe(3);
    expect(listTree(out)).toHaveLength(3);
    expect(merged.outsideTiers).toBe(1); // z2 is past the world tier's maxzoom
  });

  it('refuses an extract deeper than z14 or with an unservable compression', async () => {
    const deep = buildArchive([{ tile: { z: 15, x: 0, y: 0 }, data: new Uint8Array([1]) }]);
    await expect(
      explode({ source: bufferSource(deep), outDir: tempDir(), labelFields: LABEL_FIELDS, tiers: null }),
    ).rejects.toThrow(/z14/);
    const brotli = buildArchive([{ tile: { z: 0, x: 0, y: 0 }, data: new Uint8Array([1]) }], { tileCompression: 'brotli' });
    await expect(
      explode({ source: bufferSource(brotli), outDir: tempDir(), labelFields: LABEL_FIELDS, tiers: null }),
    ).rejects.toThrow(/brotli/);
    const gzipManifest = { tiles: 0, bytes: 0, byZoom: {}, outsideTiers: 0, observedCodepoints: [] };
    expect(() =>
      mergeManifests([
        { ...gzipManifest, tileCompression: 'gzip' },
        { ...gzipManifest, tileCompression: 'none' },
      ]),
    ).toThrow(/disagree/);
  });
});
