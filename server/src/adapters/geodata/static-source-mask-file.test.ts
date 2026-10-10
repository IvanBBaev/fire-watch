import { mkdtempSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATIC_SOURCE_KINDS,
  STATIC_SOURCE_METRIC,
  nearestStaticSource,
} from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  createStaticSourceMaskReloader,
  loadStaticSourceMask,
  type MaskFileSystem,
} from './static-source-mask-file.js';

describe('loadStaticSourceMask', () => {
  it('reads the repo copy by default', () => {
    const mask = loadStaticSourceMask(null);
    expect(mask.licence).toBe('ODbL-1.0');
    expect(mask.sources.length).toBeGreaterThan(1000);
  });

  it('fails loudly on a missing file and on a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-static-sources-'));
    expect(() => loadStaticSourceMask(join(dir, 'absent.json'))).toThrow(
      /FIRE_WATCH_STATIC_SOURCES/,
    );
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ format: 'something-else' }));
    expect(() => loadStaticSourceMask(bad)).toThrow(/format/);
  });
});

/** A one-point mask (a flare at `lon`, `lat`) in the asset's wire format. */
function maskJson(version: string, lon = 27.33, lat = 42.54): string {
  return JSON.stringify({
    format: 'fire-watch/static-sources@1',
    version,
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    scale: 10000,
    kinds: STATIC_SOURCE_KINDS,
    sources: [[3, Math.round(lon * 10000), Math.round(lat * 10000)]],
  });
}

/** An in-memory file whose stat the test moves by hand. */
function memoryFile(initial: string) {
  const state = { text: initial, mtimeMs: 1, statFails: false, reads: 0 };
  const fs: MaskFileSystem = {
    stat: () => {
      if (state.statFails) throw new Error('ENOENT');
      return { size: state.text.length, mtimeMs: state.mtimeMs };
    },
    readText: () => {
      state.reads += 1;
      return state.text;
    },
  };
  const write = (text: string): void => {
    state.text = text;
    state.mtimeMs += 1;
  };
  return { state, fs, write };
}

describe('createStaticSourceMaskReloader (hot reload)', () => {
  it('loads at creation and fails boot exactly like the one-shot loader', () => {
    const { fs } = memoryFile(maskJson('osm-a'));
    expect(createStaticSourceMaskReloader('/mask.json', fs).current().version).toBe('osm-a');
    const dir = mkdtempSync(join(tmpdir(), 'fw-static-sources-'));
    expect(() => createStaticSourceMaskReloader(join(dir, 'absent.json'))).toThrow(
      /FIRE_WATCH_STATIC_SOURCES/,
    );
  });

  it('only stats while the file is unchanged, and ignores a touch', () => {
    const file = memoryFile(maskJson('osm-a'));
    const reloader = createStaticSourceMaskReloader('/mask.json', file.fs);
    expect(reloader.check()).toEqual({ kind: 'unchanged' });
    expect(file.state.reads).toBe(1);
    file.state.mtimeMs += 10; // touch: same bytes
    expect(reloader.check()).toEqual({ kind: 'unchanged' });
    expect(file.state.reads).toBe(2);
    expect(reloader.check()).toEqual({ kind: 'unchanged' });
    expect(file.state.reads).toBe(2);
  });

  it('swaps in a new version whole, and the old object stays intact', () => {
    const file = memoryFile(maskJson('osm-a'));
    const reloader = createStaticSourceMaskReloader('/mask.json', file.fs);
    const before = reloader.current();
    file.write(maskJson('osm-b', 25.0, 42.0));
    expect(reloader.check()).toEqual({ kind: 'reloaded', from: 'osm-a', to: 'osm-b' });
    const after = reloader.current();
    expect(after.version).toBe('osm-b');
    expect(after.sources[0]?.vertices[0]).toEqual({ lon: 25, lat: 42 });
    // A cycle that took `before` keeps judging against one whole mask.
    expect(before.version).toBe('osm-a');
    expect(before.sources[0]?.vertices[0]).toEqual({ lon: 27.33, lat: 42.54 });
  });

  it('keeps the loaded mask on a half-written file, a vanished path, or a reused version', () => {
    const file = memoryFile(maskJson('osm-a'));
    const reloader = createStaticSourceMaskReloader('/mask.json', file.fs);

    file.write(maskJson('osm-b').slice(0, 40));
    expect(reloader.check()).toMatchObject({ kind: 'rejected', version: 'osm-a' });
    expect(reloader.current().version).toBe('osm-a');

    file.state.statFails = true;
    expect(reloader.check()).toMatchObject({ kind: 'rejected', reason: 'ENOENT' });
    file.state.statFails = false;

    file.write(maskJson('osm-a', 26.0, 43.0));
    expect(reloader.check()).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/version is still osm-a/) as unknown,
    });
    expect(reloader.current().sources[0]?.vertices[0]).toEqual({ lon: 27.33, lat: 42.54 });

    // The writer finishes the job: the next check picks it up.
    file.write(maskJson('osm-c'));
    expect(reloader.check()).toEqual({ kind: 'reloaded', from: 'osm-a', to: 'osm-c' });
  });

  it('picks up an atomic rename on the real file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-static-sources-'));
    const path = join(dir, 'mask.json');
    writeFileSync(path, maskJson('osm-a'));
    const reloader = createStaticSourceMaskReloader(path);
    expect(reloader.check()).toEqual({ kind: 'unchanged' });
    const next = join(dir, 'mask.json.tmp');
    writeFileSync(next, maskJson('osm-b'));
    // A distinct mtime even on a coarse-grained file system.
    utimesSync(next, new Date(2030, 0, 1), new Date(2030, 0, 1));
    renameSync(next, path);
    expect(reloader.check()).toEqual({ kind: 'reloaded', from: 'osm-a', to: 'osm-b' });
    expect(reloader.current().version).toBe('osm-b');
  });
});

describe('the committed asset (web/src/assets/geodata/static-sources.json)', () => {
  // Read here, not in the contracts package: contracts stays free of node builtins (ADR-005 D3).
  const committed = loadStaticSourceMask(null);

  it('parses, carries its licence, and holds every kind', () => {
    expect(committed.licence).toBe('ODbL-1.0');
    expect(committed.attribution).toBe('© OpenStreetMap contributors');
    for (const kind of STATIC_SOURCE_KINDS) {
      expect(committed.sources.some((s) => s.kind === kind)).toBe(true);
    }
  });

  it('stays inside the served box', () => {
    for (const s of committed.sources) {
      expect(s.minLon).toBeGreaterThanOrEqual(19.9);
      expect(s.maxLon).toBeLessThanOrEqual(31.1);
      expect(s.minLat).toBeGreaterThanOrEqual(38.9);
      expect(s.maxLat).toBeLessThanOrEqual(46.1);
    }
  });

  it('masks the Neftochim Burgas refinery site', () => {
    const hit = nearestStaticSource(
      committed,
      { lon: 27.33, lat: 42.54 },
      0,
      STATIC_SOURCE_METRIC,
      ['industrial'],
    );
    expect(hit?.distanceM).toBe(0);
  });
});
