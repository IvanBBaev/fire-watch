import { describe, expect, it } from 'vitest';

import { CLOUD_COVER } from '../config/cloud-cover.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import { cloudGrid, type CloudDocument } from '../weather/cloud-cover.js';
import { CELESTRAK_FETCHED_AT_MS, OMM_BY_NORAD } from './__fixtures__/celestrak-omm.js';
import { parseOmmBody } from './omm.js';
import { cellFor, passBucketStart, passWindowFor } from './pass-grid.js';
import { PASS_PLATFORMS } from './pass-platforms.js';
import {
  TLE_STALE_AFTER_MS,
  buildPassesDocument,
  elementsState,
  type PlatformElements,
} from './passes-document.js';

const sofia = cellFor({ lat: 42.6977, lon: 23.3219 })!;

function allElements(): PlatformElements[] {
  return PASS_PLATFORMS.map((platform) => {
    const parsed = parseOmmBody(OMM_BY_NORAD[platform.noradId]!, platform.noradId);
    if (!parsed.ok) throw new Error(parsed.reason);
    return { platform, record: parsed.record };
  });
}

const bucket = passBucketStart(CELESTRAK_FETCHED_AT_MS);

const HOUR = 3_600_000;
const SOFIA_INDEX = 6 * 22 + 6;

/**
 * A cloud forecast whose Sofia value climbs 2 % an hour from 0 % at `firstIso`, one step
 * every three hours — so the linear value at any culmination is known in closed form.
 */
function rampingCloud(firstIso: string, stepCount: number): CloudDocument {
  const grid = cloudGrid(CLOUD_COVER.values);
  const first = epochMsFromIso(firstIso);
  return {
    schema_version: 1,
    provider: 'ecmwf-open-data',
    model: 'ifs',
    kind: 'forecast',
    param: 'tcc',
    available_at: '2026-09-30T08:10:00Z',
    grid,
    steps: Array.from({ length: stepCount }, (_, i) => {
      const cells = new Array<number>(grid.cols * grid.rows).fill(100);
      cells[SOFIA_INDEX] = i * 6;
      return {
        run_at: i < 2 ? '2026-09-29T18:00:00Z' : '2026-09-30T00:00:00Z',
        step_hours: i < 2 ? 6 + i * 3 : i * 3,
        valid_at: isoFromEpochMs(first + i * 3 * HOUR),
        cloud_pct: cells,
      };
    }),
    cloud_cover_version: 'cloud_cover_v1',
    cloud_cover_digest: 'digest',
  };
}

describe('buildPassesDocument', () => {
  it('labels itself a prediction and lists every platform in canonical order', () => {
    const doc = buildPassesDocument(sofia, bucket, allElements());
    expect(doc).toMatchObject({
      schema_version: 1,
      cell: '42.75_23.25',
      point: { lat: 42.75, lon: 23.25 },
      computed_for: '2026-09-30T13:10:00Z',
      window: { from: '2026-09-30T01:10:00Z', to: '2026-10-01T13:10:00Z' },
      predicted: true,
      elements_provider: 'celestrak',
    });
    expect(doc.platforms.map((p) => p.id)).toEqual(['noaa20', 'snpp', 'noaa21', 's3a', 's3b']);
    for (const platform of doc.platforms) {
      expect(platform.elements).toBe('current');
      // A polar orbiter at 42.75°N rises several times in 36 h, at least one of them near enough.
      expect(platform.passes.length).toBeGreaterThanOrEqual(4);
      expect(platform.passes.some((p) => p.in_swath)).toBe(true);
    }
  });

  it('keeps every culmination inside the window and in order', () => {
    const doc = buildPassesDocument(sofia, bucket, allElements());
    const { fromMs, toMs } = passWindowFor(bucket);
    for (const platform of doc.platforms) {
      const culminations = platform.passes.map((p) => Date.parse(p.culmination));
      expect([...culminations].sort((a, b) => a - b)).toEqual(culminations);
      for (const ms of culminations) {
        expect(ms).toBeGreaterThanOrEqual(fromMs);
        expect(ms).toBeLessThan(toMs);
      }
    }
  });

  it('is byte-identical for the same inputs', () => {
    const a = canonicalJson(buildPassesDocument(sofia, bucket, allElements()));
    const b = canonicalJson(buildPassesDocument(sofia, bucket, allElements()));
    expect(b).toBe(a);
  });

  it('serves stale elements labelled, not hidden', () => {
    const later = bucket + TLE_STALE_AFTER_MS + 24 * 3_600_000;
    const doc = buildPassesDocument(sofia, later, allElements());
    for (const platform of doc.platforms) {
      expect(platform.elements).toBe('stale');
      expect(platform.elements_age_hours).toBeGreaterThan(72);
      expect(platform.passes.length).toBeGreaterThan(0);
    }
  });

  it('lists a platform with no elements as missing, with no passes', () => {
    const elements = allElements();
    elements[2] = { platform: elements[2]!.platform, record: null };
    const noaa21 = buildPassesDocument(sofia, bucket, elements).platforms[2];
    expect(noaa21).toEqual({
      id: 'noaa21',
      source: 'firms:viirs:noaa21',
      instrument: 'viirs',
      swath_km: 3060,
      elements: 'missing',
      elements_epoch: null,
      elements_age_hours: null,
      passes: [],
    });
  });

  it('attaches the forecast cloud at each culmination, labelled a forecast', () => {
    const cloud = rampingCloud('2026-09-30T00:00:00Z', 14);
    const doc = buildPassesDocument(sofia, bucket, allElements(), cloud);
    expect(doc.cloud).toEqual({
      kind: 'forecast',
      provider: 'ecmwf-open-data',
      model: 'ifs',
      param: 'tcc',
      at: 'culmination',
      method: 'linear_in_time',
      runs: ['2026-09-29T18:00:00Z', '2026-09-30T00:00:00Z'],
      available_at: '2026-09-30T08:10:00Z',
      cloud_cover_version: 'cloud_cover_v1',
    });
    const last = epochMsFromIso('2026-09-30T00:00:00Z') + 13 * 3 * HOUR;
    let seen = 0;
    for (const pass of doc.platforms.flatMap((p) => p.passes)) {
      const at = Date.parse(pass.culmination);
      const hours = (at - epochMsFromIso('2026-09-30T00:00:00Z')) / HOUR;
      if (hours < 0 || at > last) {
        // Before the first recorded step or after the last: no forecast, not an extrapolation.
        expect(pass.cloud_forecast_pct).toBeNull();
      } else {
        expect(pass.cloud_forecast_pct).toBe(Math.round(hours * 2));
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('carries no cloud block and null per pass when no forecast is stored', () => {
    const doc = buildPassesDocument(sofia, bucket, allElements());
    expect(doc.cloud).toBeNull();
    const passes = doc.platforms.flatMap((p) => p.passes);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((p) => p.cloud_forecast_pct === null)).toBe(true);
  });

  it('names only the runs that actually answered', () => {
    // A forecast that starts after the window ends answers no pass, so it names no run.
    const doc = buildPassesDocument(
      sofia,
      bucket,
      allElements(),
      rampingCloud('2026-10-02T00:00:00Z', 4),
    );
    expect(doc.cloud?.runs).toEqual([]);
    expect(doc.platforms.flatMap((p) => p.passes).every((p) => p.cloud_forecast_pct === null)).toBe(
      true,
    );
  });

  it('draws the stale line at exactly 72 hours', () => {
    expect(elementsState(0, TLE_STALE_AFTER_MS)).toBe('current');
    expect(elementsState(0, TLE_STALE_AFTER_MS + 1)).toBe('stale');
  });
});
