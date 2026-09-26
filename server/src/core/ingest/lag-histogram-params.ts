/**
 * `nrt_lag_histogram_v0` — the bucket edges of the NRT-lag histograms (TASKS C9; A23;
 * 13 §3.3(14); 06 §5.2.2).
 *
 * A histogram that could be re-bucketed in place would make last week's rows and this
 * week's rows look comparable when they are not, so the edges are versioned data and every
 * persisted row carries this config's version, digest *and* the edges themselves — a row
 * written under a retired version stays readable without the code that wrote it.
 *
 * ## `_v0` is load-bearing
 *
 * **Unspecified — a founder decision.** A23 asks for "NRT-lag histograms" and names no
 * buckets; neither does the SRE review's `fw_e2e_detection_latency_seconds`. These edges
 * are ours, grounded only in DATA-SOURCES' "typically 1–3 h" for FIRMS Europe NRT (so the
 * resolution is 30 minutes up to three hours) and in the poller's `day_range=2` (so the
 * last finite edge is 48 h: a row older than that on first sight cannot have come from a
 * live poll). The version is `_v0` so that the edges refit on week-one data land as `_v1`
 * and the two are never merged — `mergeLagHistograms` refuses a version or digest mismatch.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

export interface NrtLagHistogramParams {
  /**
   * Bucket lower bounds in whole minutes: bucket `i` is `[edges[i], edges[i + 1])`. The
   * first edge is 0; a lag below it (`available_at < acq_ts`, which only a wrong clock can
   * produce) is counted as `below`, and a lag at or past the last edge as `overflow`, so no
   * sample is ever dropped.
   */
  readonly edgesMinutes: readonly number[];
}

export const NRT_LAG_HISTOGRAM: VersionedConfig<NrtLagHistogramParams> = defineConfig(
  'nrt_lag_histogram',
  'nrt_lag_histogram_v0',
  {
    edgesMinutes: [0, 30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 720, 1440, 2880],
  },
);
