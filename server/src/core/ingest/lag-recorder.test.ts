import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import { VirtualClock } from '../ports/clock.js';
import type { LagHistogramStore, LagSampleReader } from '../ports/lag-histogram-store.js';
import type { DailyLagHistogram, LagSample } from './lag-histogram.js';
import { recordLagHistograms } from './lag-recorder.js';

const CONFIG = defineConfig('nrt_lag_histogram', 'nrt_lag_histogram_v9', {
  edgesMinutes: [0, 10, 60],
});

const at = (iso: string): number => Date.parse(iso);

const SAMPLES: LagSample[] = [
  // Yesterday's arrival.
  {
    source: 'firms:viirs:snpp',
    acqTsMs: at('2026-08-19T22:00:00Z'),
    availableAtMs: at('2026-08-19T22:05:00Z'),
  },
  // Acquired yesterday, arrived today: today's.
  {
    source: 'firms:viirs:snpp',
    acqTsMs: at('2026-08-19T23:50:00Z'),
    availableAtMs: at('2026-08-20T00:20:00Z'),
  },
  {
    source: 'firms:viirs:noaa20',
    acqTsMs: at('2026-08-20T09:00:00Z'),
    availableAtMs: at('2026-08-20T09:03:00Z'),
  },
];

function fakes(samples: readonly LagSample[] = SAMPLES) {
  const windows: { fromMs: number; toMs: number }[] = [];
  const written: DailyLagHistogram[][] = [];
  const reader: LagSampleReader = {
    loadLagSamples(window) {
      windows.push(window);
      return Promise.resolve(
        samples.filter((s) => s.availableAtMs >= window.fromMs && s.availableAtMs < window.toMs),
      );
    },
  };
  const store: LagHistogramStore = {
    upsertDaily(rows) {
      written.push([...rows]);
      return Promise.resolve(rows.length);
    },
    loadDaily() {
      return Promise.resolve([]);
    },
  };
  return { reader, store, windows, written };
}

describe('recordLagHistograms', () => {
  it('recomputes yesterday and today by default, one window per day', async () => {
    const { reader, store, windows, written } = fakes();
    const clock = new VirtualClock('2026-08-20T10:00:00Z');

    const report = await recordLagHistograms({ reader, store, clock, config: CONFIG });

    expect(windows).toEqual([
      { fromMs: at('2026-08-19T00:00:00Z'), toMs: at('2026-08-20T00:00:00Z') },
      { fromMs: at('2026-08-20T00:00:00Z'), toMs: at('2026-08-21T00:00:00Z') },
    ]);
    expect(written.map((rows) => rows.map((r) => [r.day, r.histogram.source]))).toEqual([
      [['2026-08-19', 'firms:viirs:snpp']],
      [
        ['2026-08-20', 'firms:viirs:noaa20'],
        ['2026-08-20', 'firms:viirs:snpp'],
      ],
    ]);
    expect(written[1]?.[1]?.histogram.counts).toEqual([0, 1]);
    expect(report).toEqual({
      at: '2026-08-20T10:00:00Z',
      histogramVersion: 'nrt_lag_histogram_v9',
      histogramDigest: CONFIG.digest,
      days: [
        { day: '2026-08-19', samples: 1, sources: 1 },
        { day: '2026-08-20', samples: 2, sources: 2 },
      ],
      rowsWritten: 3,
    });
  });

  it('reports an empty day without writing anything', async () => {
    const { reader, store, written } = fakes([]);
    const report = await recordLagHistograms({
      reader,
      store,
      clock: new VirtualClock('2026-08-20T10:00:00Z'),
      config: CONFIG,
    });
    expect(written).toEqual([]);
    expect(report.rowsWritten).toBe(0);
    expect(report.days.map((d) => d.samples)).toEqual([0, 0]);
  });

  it('takes explicit days, deduplicated and sorted', async () => {
    const { reader, store, windows } = fakes();
    const report = await recordLagHistograms(
      { reader, store, clock: new VirtualClock('2026-09-01T00:00:00Z'), config: CONFIG },
      { days: ['2026-08-20', '2026-08-19', '2026-08-20'] },
    );
    expect(windows).toHaveLength(2);
    expect(report.days.map((d) => d.day)).toEqual(['2026-08-19', '2026-08-20']);
  });

  it('refuses an invalid day before reading anything', async () => {
    const { reader, store, windows } = fakes();
    await expect(
      recordLagHistograms(
        { reader, store, clock: new VirtualClock('2026-09-01T00:00:00Z'), config: CONFIG },
        { days: ['2026-02-30'] },
      ),
    ).rejects.toThrow('not a calendar date');
    expect(windows).toEqual([]);
  });

  it('keeps only the day asked for when a reader returns a sample outside it', async () => {
    const stray: LagSample = {
      source: 'firms:viirs:snpp',
      acqTsMs: 0,
      availableAtMs: at('2026-08-25T00:00:00Z'),
    };
    const reader: LagSampleReader = { loadLagSamples: () => Promise.resolve([stray]) };
    const { store, written } = fakes();
    const report = await recordLagHistograms(
      { reader, store, clock: new VirtualClock('2026-09-01T00:00:00Z'), config: CONFIG },
      { days: ['2026-08-20'] },
    );
    expect(written).toEqual([]);
    expect(report.days).toEqual([{ day: '2026-08-20', samples: 0, sources: 0 }]);
  });
});
