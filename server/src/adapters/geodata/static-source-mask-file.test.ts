import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATIC_SOURCE_KINDS,
  STATIC_SOURCE_METRIC,
  nearestStaticSource,
} from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { loadStaticSourceMask } from './static-source-mask-file.js';

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
