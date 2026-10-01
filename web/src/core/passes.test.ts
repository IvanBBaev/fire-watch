/**
 * TASKS F15, web half: the pass document's validation, the cell a map point asks for, and
 * which pass is "last" and which "next". The fixture is the one the fixture build serves,
 * generated from the server's own SGP4 path — so parsing it proves the wire shapes agree.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, LIVE_PASSES_URL_TEMPLATE, withDataSource } from './config.js';
import { POLLING_AREA } from './geo/coverage.js';
import {
  PASS_CELL_DEG,
  lastAndNext,
  parsePassesDocument,
  passCellFor,
  passesUrl,
  passesWindowEnded,
  type PassEntry,
  type PlatformPasses,
} from './passes.js';

const FIXTURE: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/passes/sample.json', import.meta.url)),
    'utf8',
  ),
);

/** The server's canonical-id rule (`pass-grid.ts` `CELL_ID_RE` plus round-trip). */
const CELL_ID_RE = /^(-?\d{1,2}\.\d{2})_(-?\d{1,3}\.\d{2})$/;

function pass(culmination: string, in_swath = true): PassEntry {
  return {
    aos: culmination,
    culmination,
    los: culmination,
    max_elevation_deg: 40,
    cross_track_km: 100,
    in_swath,
    daylight: 'day',
    cloud_forecast_pct: null,
  };
}

function platform(passes: readonly PassEntry[]): PlatformPasses {
  return {
    id: 'noaa20',
    source: 'VIIRS_NOAA20_NRT',
    instrument: 'viirs',
    swath_km: 3060,
    elements: 'current',
    elements_epoch: '2026-09-30T00:00:00Z',
    elements_age_hours: 8,
    passes,
  };
}

describe('passCellFor', () => {
  it('maps the default view to the cell the fixture was computed for', () => {
    expect(passCellFor(42.4, 25.4)).toBe('42.25_25.25');
    expect(parsePassesDocument(FIXTURE)?.cell).toBe('42.25_25.25');
  });

  it('answers null outside the polled box and for non-finite input', () => {
    expect(passCellFor(50, 25)).toBeNull();
    expect(passCellFor(42, 35)).toBeNull();
    expect(passCellFor(Number.NaN, 25)).toBeNull();
    expect(passCellFor(42, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('always names a canonical cell centre within half a cell of the point', () => {
    fc.assert(
      fc.property(
        fc.double({ min: POLLING_AREA.south, max: POLLING_AREA.north, noNaN: true }),
        fc.double({ min: POLLING_AREA.west, max: POLLING_AREA.east, noNaN: true }),
        (lat, lon) => {
          const cell = passCellFor(lat, lon);
          if (cell === null) return;
          const match = CELL_ID_RE.exec(cell);
          expect(match).not.toBeNull();
          const centreLat = Number(match?.[1]);
          const centreLon = Number(match?.[2]);
          expect(Math.abs(centreLat - lat)).toBeLessThanOrEqual(PASS_CELL_DEG / 2);
          expect(Math.abs(centreLon - lon)).toBeLessThanOrEqual(PASS_CELL_DEG / 2);
          // The centre asks for itself: the id is a fixed point, as the server requires.
          expect(passCellFor(centreLat, centreLon)).toBe(cell);
        },
      ),
    );
  });
});

describe('passesUrl and the configured template', () => {
  it('fills the cell into a template and leaves a fixture path alone', () => {
    expect(passesUrl('/api/v1/passes/{cell}', '42.25_25.25')).toBe('/api/v1/passes/42.25_25.25');
    expect(passesUrl('/fixtures/passes/sample.json', '42.25_25.25')).toBe(
      '/fixtures/passes/sample.json',
    );
  });

  it('serves the fixture by default and the route in live mode', () => {
    expect(DEFAULT_CONFIG.passesUrlTemplate).toBe('/fixtures/passes/sample.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').passesUrlTemplate).toBe(LIVE_PASSES_URL_TEMPLATE);
  });
});

describe('parsePassesDocument', () => {
  it('accepts the fixture with all five platforms', () => {
    const doc = parsePassesDocument(FIXTURE);
    expect(doc).not.toBeNull();
    expect(doc?.predicted).toBe(true);
    expect(doc?.platforms.map((p) => p.id).sort()).toEqual([
      'noaa20',
      'noaa21',
      's3a',
      's3b',
      'snpp',
    ]);
  });

  it.each([
    ['not an object', 'x'],
    ['another schema', { ...(FIXTURE as object), schema_version: 2 }],
    ['not marked as predicted', { ...(FIXTURE as object), predicted: false }],
    ['another provider', { ...(FIXTURE as object), elements_provider: 'space-track' }],
    ['a bad instant', { ...(FIXTURE as object), computed_for: 'yesterday' }],
    ['no platforms', { ...(FIXTURE as object), platforms: null }],
    ['an unknown platform', { ...(FIXTURE as object), platforms: [{ id: 'aqua' }] }],
  ])('rejects %s', (_label, body) => {
    expect(parsePassesDocument(body)).toBeNull();
  });

  it('rejects the whole document when one pass is malformed', () => {
    const doc = structuredClone(FIXTURE) as {
      platforms: { passes: Record<string, unknown>[] }[];
    };
    const first = doc.platforms[0]?.passes[0];
    if (first !== undefined) first['daylight'] = 'dusk';
    expect(parsePassesDocument(doc)).toBeNull();
  });
});

describe('lastAndNext', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z');

  it('picks the latest past and the earliest future in-swath pass', () => {
    const result = lastAndNext(
      platform([
        pass('2026-09-30T02:00:00Z'),
        pass('2026-09-30T11:00:00Z'),
        pass('2026-09-30T11:30:00Z', false),
        pass('2026-10-01T01:00:00Z'),
        pass('2026-09-30T13:00:00Z'),
        pass('2026-09-30T12:30:00Z', false),
      ]),
      NOW,
    );
    expect(result.last?.culmination).toBe('2026-09-30T11:00:00Z');
    expect(result.next?.culmination).toBe('2026-09-30T13:00:00Z');
  });

  it('treats a culmination exactly at now as the last look', () => {
    const result = lastAndNext(platform([pass('2026-09-30T12:00:00Z')]), NOW);
    expect(result.last?.culmination).toBe('2026-09-30T12:00:00Z');
    expect(result.next).toBeNull();
  });

  it('never offers an out-of-swath pass, whatever the order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ offsetMin: fc.integer({ min: -720, max: 1440 }), inSwath: fc.boolean() }),
        ),
        (specs) => {
          const passes = specs.map(({ offsetMin, inSwath }) =>
            pass(new Date(NOW + offsetMin * 60_000).toISOString(), inSwath),
          );
          const { last, next } = lastAndNext(platform(passes), NOW);
          const seen = passes.filter((p) => p.in_swath).map((p) => Date.parse(p.culmination));
          const past = seen.filter((ms) => ms <= NOW);
          const future = seen.filter((ms) => ms > NOW);
          expect(last === null ? null : Date.parse(last.culmination)).toBe(
            past.length === 0 ? null : Math.max(...past),
          );
          expect(next === null ? null : Date.parse(next.culmination)).toBe(
            future.length === 0 ? null : Math.min(...future),
          );
        },
      ),
    );
  });
});

describe('passesWindowEnded', () => {
  it('flips once the forward window is behind now', () => {
    const doc = parsePassesDocument(FIXTURE);
    if (doc === null) throw new Error('fixture must parse');
    const end = Date.parse(doc.window.to);
    expect(passesWindowEnded(doc, end - 1)).toBe(false);
    expect(passesWindowEnded(doc, end)).toBe(true);
  });
});
