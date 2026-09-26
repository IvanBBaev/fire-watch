/**
 * The client's copy of the coverage geometry, guarded two ways: the numbers are pinned as
 * literals here, and they are diffed against `server/src/core/config/polling-bbox.ts` —
 * the source of truth the web package is not allowed to import. Widening the polled area
 * on the server while the browser keeps telling users something narrower is the drift this
 * test exists to make loud.
 */

// Browser-only tsconfig; this file runs in the node vitest project and reads the server
// config off disk. Scoped reference rather than widening the package's `types`.
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BULGARIA_ENVELOPE,
  COVERAGE_BUFFER_KM,
  COVERED_AREA,
  isInsideCoverage,
  POLLING_AREA,
} from './coverage.js';
import type { GeoBounds } from './viewport.js';
import { expandBoundsKm } from './viewport.js';

const serverConfig = readFileSync(
  fileURLToPath(new URL('../../../../server/src/core/config/polling-bbox.ts', import.meta.url)),
  'utf8',
);

/** Pull the first `{ west, south, east, north }` literal that follows an identifier. */
function serverBbox(identifier: string): GeoBounds {
  const match = new RegExp(
    `${identifier}[\\s\\S]{0,300}?west:\\s*(-?[\\d.]+),\\s*south:\\s*(-?[\\d.]+),` +
      `\\s*east:\\s*(-?[\\d.]+),\\s*north:\\s*(-?[\\d.]+)`,
  ).exec(serverConfig);
  if (match === null) throw new Error(`no bbox literal found after ${identifier}`);
  const [west, south, east, north] = match.slice(1, 5).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { west, south, east, north };
}

describe('the transcribed geometry', () => {
  it('pins Bulgaria s envelope to the documented thousandths of a degree', () => {
    expect(BULGARIA_ENVELOPE).toEqual({
      west: 22.357,
      south: 41.235,
      east: 28.612,
      north: 44.215,
    });
  });

  it('pins the polled box to 20-31 E / 39-46 N', () => {
    expect(POLLING_AREA).toEqual({ west: 20.0, south: 39.0, east: 31.0, north: 46.0 });
  });

  it('matches the server envelope it transcribes', () => {
    expect(BULGARIA_ENVELOPE).toEqual(serverBbox('BULGARIA_ENVELOPE'));
  });

  it('matches the server polling bbox it transcribes', () => {
    expect(POLLING_AREA).toEqual(serverBbox('POLLING_BBOX'));
  });

  it('matches the server cross-border buffer', () => {
    const match = /ALERTABLE_BUFFER_KM = (\d+)/.exec(serverConfig);
    expect(match?.[1]).toBe(String(COVERAGE_BUFFER_KM));
  });
});

describe('COVERED_AREA', () => {
  it('is the envelope grown by the buffer, not a second hand-written box', () => {
    expect(COVERED_AREA).toEqual(expandBoundsKm(BULGARIA_ENVELOPE, COVERAGE_BUFFER_KM));
  });

  it('stays inside the polled box, so we never promise more than we ask for', () => {
    expect(COVERED_AREA.west).toBeGreaterThan(POLLING_AREA.west);
    expect(COVERED_AREA.east).toBeLessThan(POLLING_AREA.east);
    expect(COVERED_AREA.south).toBeGreaterThan(POLLING_AREA.south);
    expect(COVERED_AREA.north).toBeLessThan(POLLING_AREA.north);
  });
});

describe('isInsideCoverage', () => {
  it('covers Bulgaria', () => {
    expect(isInsideCoverage(23.32, 42.7)).toBe(true); // Sofia
    expect(isInsideCoverage(27.91, 43.21)).toBe(true); // Varna
  });

  it('covers the cross-border band, because fires do not stop at the border', () => {
    expect(isInsideCoverage(21.43, 41.99)).toBe(true); // Skopje
    expect(isInsideCoverage(24.62, 45.0)).toBe(true); // south of Bucharest, inside the band
    expect(isInsideCoverage(24.75, 40.94)).toBe(true); // Kavala, northern Greece
  });

  it('rejects places we make no claim about', () => {
    expect(isInsideCoverage(-9.14, 38.72)).toBe(false); // Lisbon
    expect(isInsideCoverage(37.62, 55.75)).toBe(false); // Moscow
    expect(isInsideCoverage(32.86, 39.93)).toBe(false); // Ankara — east of the band
  });

  it('rejects a missing fix rather than treating it as the origin', () => {
    expect(isInsideCoverage(Number.NaN, Number.NaN)).toBe(false);
  });
});
