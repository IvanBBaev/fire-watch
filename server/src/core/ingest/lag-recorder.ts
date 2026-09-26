/**
 * Recomputes and persists the daily NRT-lag histograms (TASKS C9; A23: "histograms
 * persisted").
 *
 * Each run recomputes whole UTC days from `detections` and replaces their rows, rather than
 * adding the samples since the last run. A recompute is idempotent — a run repeated, lost
 * or overlapping another writes the same rows — and it needs no cursor to get wrong. The
 * cost is one day's detections per day recomputed, which over the Bulgarian bbox is
 * hundreds of rows, not millions.
 *
 * By default a run covers the current UTC day and the one before it. The previous day is
 * there for the rows first seen by a poll that started before midnight and committed after
 * it: recomputing it once more after it closes is what makes a closed day final.
 */

import type { VersionedConfig } from '../config/versioned-config.js';
import type { Clock } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { LagHistogramStore, LagSampleReader } from '../ports/lag-histogram-store.js';
import { dailyLagHistograms, utcDayOf, utcDayStartMs } from './lag-histogram.js';
import type { NrtLagHistogramParams } from './lag-histogram-params.js';

const MS_PER_DAY = 86_400_000;

export interface LagRecorderDeps {
  readonly reader: LagSampleReader;
  readonly store: LagHistogramStore;
  readonly clock: Clock;
  readonly config: VersionedConfig<NrtLagHistogramParams>;
}

export interface LagRecordReport {
  readonly at: string;
  readonly histogramVersion: string;
  readonly histogramDigest: string;
  /** One entry per day recomputed, oldest first — including days with no samples. */
  readonly days: readonly {
    readonly day: string;
    readonly samples: number;
    readonly sources: number;
  }[];
  readonly rowsWritten: number;
}

/**
 * `days` overrides the default (yesterday and today, UTC). Each is `YYYY-MM-DD`; an
 * invalid date throws before anything is read.
 */
export async function recordLagHistograms(
  deps: LagRecorderDeps,
  options: { readonly days?: readonly string[] } = {},
): Promise<LagRecordReport> {
  const now = deps.clock.now();
  const days = [...new Set(options.days ?? [utcDayOf(now - MS_PER_DAY), utcDayOf(now)])].sort();
  const starts = days.map((day) => utcDayStartMs(day));

  const perDay: { day: string; samples: number; sources: number }[] = [];
  let rowsWritten = 0;
  for (const [i, day] of days.entries()) {
    const fromMs = starts[i] ?? 0;
    const samples = await deps.reader.loadLagSamples({ fromMs, toMs: fromMs + MS_PER_DAY });
    // The reader's window is the day, so every sample keys to it; the filter is a guard
    // against a reader whose window is off by one, not a second definition of the day.
    const rows = dailyLagHistograms(samples, deps.config).filter((row) => row.day === day);
    if (rows.length > 0) rowsWritten += await deps.store.upsertDaily(rows);
    perDay.push({
      day,
      samples: rows.reduce((sum, row) => sum + row.histogram.total, 0),
      sources: rows.length,
    });
  }

  return {
    at: isoFromEpochMs(now),
    histogramVersion: deps.config.version,
    histogramDigest: deps.config.digest,
    days: perDay,
    rowsWritten,
  };
}
