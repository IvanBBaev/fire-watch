/**
 * ECMWF Open Data as the weather refresh sees it (TASKS C4, DATA-SOURCES §D2).
 *
 * ECMWF publishes each forecast run as one large GRIB2 file per step with a companion
 * `.index` of JSON lines giving every field's byte offset and length. The whole file is
 * hundreds of megabytes and we need six surface fields of it, so the access pattern is:
 * fetch the index, then range-request exactly the fields we keep. Both operations are
 * value-style — a provider hiccup is recorded, never thrown.
 */

import type { EpochMs } from './clock.js';

/** One published forecast run: `dateYmd` is `YYYYMMDD`, `hour` is the cycle (0/6/12/18). */
export interface ForecastCycleRef {
  readonly dateYmd: string;
  readonly hour: number;
}

export interface WeatherIndexFetch {
  /** The `.index` body as text, or `null` when the request failed. */
  readonly text: string | null;
  readonly availableAt: EpochMs | null;
  /** `null` exactly when `text` is not. */
  readonly error: string | null;
}

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface WeatherRangeFetch {
  /** Exactly `range.length` bytes, or `null` when the request failed or was truncated. */
  readonly bytes: Uint8Array | null;
  readonly availableAt: EpochMs | null;
  readonly error: string | null;
}

export interface WeatherClient {
  fetchIndex(cycle: ForecastCycleRef, step: number): Promise<WeatherIndexFetch>;
  fetchRange(cycle: ForecastCycleRef, step: number, range: ByteRange): Promise<WeatherRangeFetch>;
}
