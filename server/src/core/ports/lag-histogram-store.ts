/**
 * The NRT-lag histograms' read and write sides (TASKS C9; A23; migration 008).
 *
 * Two ports, because the samples come from `detections` and the histograms go to
 * `nrt_lag_histograms`, and a test of the recorder should be able to fake either alone.
 * The inclusion rules are stated here so an adapter cannot quietly pick others:
 *
 *   - **The window is on `available_at`**, half-open: `from ≤ available_at < to`. A day is
 *     keyed by arrival (see `core/ingest/lag-histogram.ts`), so the reader must be too.
 *   - **SP rows are excluded** (`product_tier <> 'SP'`). A D7 promotion stamps the fetch
 *     instant as `available_at`, which would put a two-month-old acquisition in `overflow`
 *     and tell the reader FIRMS is two months late.
 *   - **Quarantined rows are included.** A quarantine is a verdict on content; the row
 *     still arrived when it arrived.
 *   - **Every source is included**, retired ones too: a histogram is history.
 */

import type { DailyLagHistogram, LagSample } from '../ingest/lag-histogram.js';
import type { EpochMs } from './clock.js';

export interface LagSampleReader {
  loadLagSamples(window: {
    readonly fromMs: EpochMs;
    readonly toMs: EpochMs;
  }): Promise<readonly LagSample[]>;
}

export interface LagHistogramStore {
  /**
   * Inserts or replaces one row per (day, source, histogram version). Replacing is the
   * point: the current UTC day is recomputed until it closes. Returns the rows written.
   */
  upsertDaily(rows: readonly DailyLagHistogram[]): Promise<number>;
  /** Inclusive day range, one version, sorted by day then source. */
  loadDaily(query: {
    readonly fromDay: string;
    readonly toDay: string;
    readonly histogramVersion: string;
  }): Promise<readonly DailyLagHistogram[]>;
}
