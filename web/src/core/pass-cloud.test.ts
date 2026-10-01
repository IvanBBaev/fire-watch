/**
 * TASKS F17, web half: the per-pass cloud forecast's validation and its three words. The
 * fixture is generated from the server's own path (real ECMWF `tcc` bytes through the
 * passes document), so parsing it proves the wire shapes agree.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PASS_CLOUD_CLEAR_MAX_PCT,
  PASS_CLOUD_CLOUDY_MIN_PCT,
  isInvalid,
  parsePassCloudPct,
  parsePassesCloud,
  passCloudLevel,
} from './pass-cloud.js';
import { parsePassesDocument } from './passes.js';

const FIXTURE: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/passes/sample.json', import.meta.url)),
    'utf8',
  ),
);

type MutableDoc = {
  cloud: Record<string, unknown> | null;
  platforms: { passes: Record<string, unknown>[] }[];
};

const clone = (): MutableDoc => structuredClone(FIXTURE) as MutableDoc;

describe('passCloudLevel', () => {
  it('draws the okta boundaries inclusively', () => {
    expect(passCloudLevel(0)).toBe('clear');
    expect(passCloudLevel(PASS_CLOUD_CLEAR_MAX_PCT)).toBe('clear');
    expect(passCloudLevel(PASS_CLOUD_CLEAR_MAX_PCT + 1)).toBe('partly');
    expect(passCloudLevel(PASS_CLOUD_CLOUDY_MIN_PCT - 1)).toBe('partly');
    expect(passCloudLevel(PASS_CLOUD_CLOUDY_MIN_PCT)).toBe('cloudy');
    expect(passCloudLevel(100)).toBe('cloudy');
  });

  it('never reads more cloud as a clearer sky', () => {
    const rank = { clear: 0, partly: 1, cloudy: 2 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(rank[passCloudLevel(lo)]).toBeLessThanOrEqual(rank[passCloudLevel(hi)]);
      }),
    );
  });
});

describe('parsePassCloudPct', () => {
  it.each([
    [undefined, null],
    [null, null],
    [0, 0],
    [100, 100],
    [57, 57],
  ])('reads %s as %s', (raw, expected) => {
    expect(parsePassCloudPct(raw)).toBe(expected);
  });

  it.each([[-1], [101], [12.5], ['40'], [Number.NaN]])('rejects %s', (raw) => {
    expect(isInvalid(parsePassCloudPct(raw))).toBe(true);
  });
});

describe('parsePassesCloud', () => {
  const block = (FIXTURE as MutableDoc).cloud;

  it('reads the fixture block as a labelled forecast', () => {
    expect(parsePassesCloud(block)).toEqual({
      kind: 'forecast',
      provider: 'ecmwf-open-data',
      model: 'ifs',
      param: 'tcc',
      at: 'culmination',
      method: 'linear_in_time',
      runs: ['2026-09-30T00:00:00Z'],
      available_at: expect.any(String) as string,
      cloud_cover_version: 'cloud_cover_v1',
    });
    expect(parsePassesCloud(undefined)).toBeNull();
    expect(parsePassesCloud(null)).toBeNull();
  });

  it.each([
    ['an observation', { kind: 'observation' }],
    ['another provider', { provider: 'gfs' }],
    ['another method', { method: 'nearest' }],
    ['a bad run', { runs: ['soon'] }],
    ['no version', { cloud_cover_version: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(isInvalid(parsePassesCloud({ ...block, ...patch }))).toBe(true);
  });
});

describe('parsePassesDocument with cloud (F17)', () => {
  it('carries the fixture forecast onto the passes that have one', () => {
    const doc = parsePassesDocument(FIXTURE);
    expect(doc?.cloud?.kind).toBe('forecast');
    const values = doc?.platforms.flatMap((p) => p.passes.map((x) => x.cloud_forecast_pct)) ?? [];
    expect(values.some((v) => v !== null)).toBe(true);
    expect(values.some((v) => v === null)).toBe(true);
  });

  it('reads a document from before F17 as "no forecast"', () => {
    const doc = clone() as Partial<MutableDoc>;
    delete doc.cloud;
    for (const platform of doc.platforms ?? []) {
      for (const pass of platform.passes) delete pass['cloud_forecast_pct'];
    }
    const parsed = parsePassesDocument(doc);
    expect(parsed?.cloud).toBeNull();
    expect(
      parsed?.platforms.flatMap((p) => p.passes).every((p) => p.cloud_forecast_pct === null),
    ).toBe(true);
  });

  it('rejects the whole document for one malformed value', () => {
    const doc = clone();
    doc.platforms[0]!.passes[0]!['cloud_forecast_pct'] = 140;
    expect(parsePassesDocument(doc)).toBeNull();
  });

  it('rejects a value with nothing saying it is a forecast', () => {
    const doc = clone();
    doc.cloud = null;
    expect(parsePassesDocument(doc)).toBeNull();
  });
});
