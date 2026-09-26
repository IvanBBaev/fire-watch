import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import {
  addLag,
  assertLagEdges,
  availabilityProfile,
  AVAILABILITY_PROFILE_FORMAT,
  buildLagHistograms,
  dailyLagHistograms,
  emptyLagHistogram,
  lagQuantileMs,
  mergeLagHistograms,
  renderAvailabilityProfile,
  utcDayOf,
  utcDayStartMs,
  type LagSample,
} from './lag-histogram.js';
import { NRT_LAG_HISTOGRAM } from './lag-histogram-params.js';

const MIN = 60_000;
const CONFIG = defineConfig('nrt_lag_histogram', 'nrt_lag_histogram_v9', {
  edgesMinutes: [0, 10, 60],
});
const OTHER = defineConfig('nrt_lag_histogram', 'nrt_lag_histogram_v8', {
  edgesMinutes: [0, 30, 60],
});

const SNPP = 'firms:viirs:snpp' as const;
const NOAA20 = 'firms:viirs:noaa20' as const;
const T0 = Date.parse('2026-08-20T10:00:00Z');

const sample = (source: LagSample['source'], lagMs: number, acqTsMs = T0): LagSample => ({
  source,
  acqTsMs,
  availableAtMs: acqTsMs + lagMs,
});

describe('the shipped edges', () => {
  it('are valid and flagged provisional by their _v0 version', () => {
    expect(() => {
      assertLagEdges(NRT_LAG_HISTOGRAM.values.edgesMinutes);
    }).not.toThrow();
    expect(NRT_LAG_HISTOGRAM.version).toBe('nrt_lag_histogram_v0');
    // Two days of overflow headroom: FIRMS' area API serves at most day_range=2 back.
    expect(NRT_LAG_HISTOGRAM.values.edgesMinutes.at(-1)).toBe(2880);
  });
});

describe('assertLagEdges', () => {
  it.each([
    [[0], 'at least two'],
    [[5, 10], 'start at 0'],
    [[0, 10, 10], 'strictly increasing'],
    [[0, 1.5], 'whole number'],
  ])('refuses %j', (edges, message) => {
    expect(() => {
      assertLagEdges(edges);
    }).toThrow(message);
  });
});

describe('addLag', () => {
  it('buckets half-open [lo, hi) and sends the tails to below and overflow', () => {
    let h = emptyLagHistogram(SNPP, CONFIG);
    for (const lag of [0, 10 * MIN - 1, 10 * MIN, 60 * MIN - 1, 60 * MIN, -1]) h = addLag(h, lag);
    expect(h.counts).toEqual([2, 2]);
    expect(h.below).toBe(1);
    expect(h.overflow).toBe(1);
    expect(h.total).toBe(6);
    expect(h.minLagMs).toBe(-1);
    expect(h.maxLagMs).toBe(60 * MIN);
  });

  it('does not mutate its argument', () => {
    const h = emptyLagHistogram(SNPP, CONFIG);
    addLag(h, 5 * MIN);
    expect(h.total).toBe(0);
    expect(h.counts).toEqual([0, 0]);
  });

  it('refuses a non-finite lag', () => {
    expect(() => addLag(emptyLagHistogram(SNPP, CONFIG), Number.NaN)).toThrow('finite');
  });

  it('carries the config version and digest', () => {
    const h = emptyLagHistogram(SNPP, CONFIG);
    expect(h.histogramVersion).toBe('nrt_lag_histogram_v9');
    expect(h.histogramDigest).toBe(CONFIG.digest);
    expect(h.minLagMs).toBeNull();
  });
});

describe('buildLagHistograms', () => {
  const samples = [sample(NOAA20, 5 * MIN), sample(SNPP, 20 * MIN), sample(SNPP, 3 * MIN)];

  it('gives one histogram per source, sorted by source', () => {
    const hs = buildLagHistograms(samples, CONFIG);
    expect(hs.map((h) => h.source)).toEqual([NOAA20, SNPP]);
    expect(hs[1]?.counts).toEqual([1, 1]);
  });

  it('is independent of input order', () => {
    expect(buildLagHistograms([...samples].reverse(), CONFIG)).toEqual(
      buildLagHistograms(samples, CONFIG),
    );
  });
});

describe('dailyLagHistograms', () => {
  it('keys by the UTC day of arrival, not acquisition', () => {
    const acq = Date.parse('2026-08-20T23:50:00Z');
    const daily = dailyLagHistograms(
      [sample(SNPP, 5 * MIN, acq), sample(SNPP, 20 * MIN, acq), sample(NOAA20, MIN, T0)],
      CONFIG,
    );
    expect(daily.map((d) => [d.day, d.histogram.source, d.histogram.total])).toEqual([
      ['2026-08-20', NOAA20, 1],
      ['2026-08-20', SNPP, 1],
      ['2026-08-21', SNPP, 1],
    ]);
  });
});

describe('mergeLagHistograms', () => {
  const a = buildLagHistograms([sample(SNPP, MIN), sample(SNPP, -5)], CONFIG)[0];
  const b = buildLagHistograms([sample(SNPP, 30 * MIN)], CONFIG)[0];
  const c = buildLagHistograms([sample(SNPP, 90 * MIN), sample(SNPP, 2 * MIN)], CONFIG)[0];
  if (a === undefined || b === undefined || c === undefined) throw new Error('fixture');

  it('equals building from the union of samples', () => {
    const all = buildLagHistograms(
      [MIN, -5, 30 * MIN, 90 * MIN, 2 * MIN].map((lag) => sample(SNPP, lag)),
      CONFIG,
    )[0];
    expect(mergeLagHistograms(mergeLagHistograms(a, b), c)).toEqual(all);
  });

  it('is associative and commutative', () => {
    const left = mergeLagHistograms(mergeLagHistograms(a, b), c);
    expect(mergeLagHistograms(a, mergeLagHistograms(b, c))).toEqual(left);
    expect(mergeLagHistograms(c, mergeLagHistograms(b, a))).toEqual(left);
  });

  it('treats the empty histogram as identity', () => {
    expect(mergeLagHistograms(emptyLagHistogram(SNPP, CONFIG), a)).toEqual(a);
  });

  it('refuses another source or other edges', () => {
    expect(() => mergeLagHistograms(a, emptyLagHistogram(NOAA20, CONFIG))).toThrow(
      'cannot merge lag histograms of',
    );
    expect(() => mergeLagHistograms(a, emptyLagHistogram(SNPP, OTHER))).toThrow('different edges');
  });
});

describe('lagQuantileMs', () => {
  it('is null for an empty histogram', () => {
    expect(lagQuantileMs(emptyLagHistogram(SNPP, CONFIG), 0.5)).toBeNull();
  });

  it('refuses q outside [0, 1]', () => {
    expect(() => lagQuantileMs(emptyLagHistogram(SNPP, CONFIG), 1.5)).toThrow('[0, 1]');
  });

  it('interpolates inside a bucket and clamps to the observed extremes', () => {
    // Four lags in [0, 10) min and four in [10, 60) min.
    const lags = [1, 2, 3, 4].map((m) => m * MIN).concat([20, 30, 40, 50].map((m) => m * MIN));
    const h = buildLagHistograms(
      lags.map((lag) => sample(SNPP, lag)),
      CONFIG,
    )[0];
    if (h === undefined) throw new Error('fixture');
    expect(lagQuantileMs(h, 0)).toBe(MIN);
    expect(lagQuantileMs(h, 0.5)).toBe(10 * MIN);
    // [10, 60) clamped to the observed max: [10, 50], halfway through it.
    expect(lagQuantileMs(h, 0.75)).toBe(30 * MIN);
    expect(lagQuantileMs(h, 1)).toBe(50 * MIN);
  });

  it('bounds the overflow tail by the observed maximum', () => {
    const h = buildLagHistograms([sample(SNPP, 100 * MIN)], CONFIG)[0];
    if (h === undefined) throw new Error('fixture');
    expect(lagQuantileMs(h, 0.5)).toBe(100 * MIN);
  });
});

describe('utc days', () => {
  it('round-trips a day', () => {
    expect(utcDayOf(utcDayStartMs('2026-08-20'))).toBe('2026-08-20');
    expect(utcDayStartMs('2026-08-20')).toBe(Date.parse('2026-08-20T00:00:00Z'));
  });

  it.each(['2026-02-30', '2026-8-20', '20260820', ''])('refuses %j', (day) => {
    expect(() => utcDayStartMs(day)).toThrow(RangeError);
  });
});

describe('availabilityProfile', () => {
  const daily = dailyLagHistograms(
    [
      sample(SNPP, 5 * MIN, Date.parse('2026-08-19T12:00:00Z')),
      sample(SNPP, 20 * MIN, Date.parse('2026-08-20T12:00:00Z')),
      sample(NOAA20, 90 * MIN, Date.parse('2026-08-20T12:00:00Z')),
      sample(SNPP, 7 * MIN, Date.parse('2026-08-22T12:00:00Z')),
    ],
    CONFIG,
  );

  it('merges per source over the inclusive window', () => {
    const profile = availabilityProfile({
      histogramVersion: CONFIG.version,
      window: { fromDay: '2026-08-19', toDay: '2026-08-20' },
      daily,
    });
    expect(profile.format).toBe(AVAILABILITY_PROFILE_FORMAT);
    expect(Object.keys(profile.sources)).toEqual([NOAA20, SNPP]);
    expect(profile.sources[SNPP]?.days).toBe(2);
    expect(profile.sources[SNPP]?.counts).toEqual([1, 1]);
    expect(profile.sources[NOAA20]?.overflow).toBe(1);
    expect(profile.sources[NOAA20]?.quantilesMs.p50).toBe(90 * MIN);
  });

  it('renders identically for any input order', () => {
    const window = { fromDay: '2026-08-19', toDay: '2026-08-22' };
    const one = renderAvailabilityProfile(
      availabilityProfile({ histogramVersion: CONFIG.version, window, daily }),
    );
    const two = renderAvailabilityProfile(
      availabilityProfile({
        histogramVersion: CONFIG.version,
        window,
        daily: [...daily].reverse(),
      }),
    );
    expect(two).toBe(one);
  });

  it('refuses a daily row of another version', () => {
    expect(() =>
      availabilityProfile({
        histogramVersion: OTHER.version,
        window: { fromDay: '2026-08-19', toDay: '2026-08-22' },
        daily,
      }),
    ).toThrow('not nrt_lag_histogram_v8');
  });
});
