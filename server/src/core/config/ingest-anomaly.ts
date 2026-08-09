/**
 * `ingest_anomaly_v1` — the ingest anomaly breaker's parameters (TASKS C2; 01 §6.1.3).
 *
 * The failure this guards against is a sensor artifact flooding the map: dawn/dusk sun
 * glint, an FCI processing glitch, a provider re-publishing a whole archive into the NRT
 * feed. The map fills with pixels that are not fires, clustering builds events from them,
 * and alerts go out. Detecting it needs no cleverness — an artifact is *much* larger than
 * a fire day — only a baseline that does not move when the artifact does.
 *
 * Versioned rather than hardcoded because these are the numbers a replay of a quarantined
 * September batch has to run under to reproduce the decision (ADR-002 D5).
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface IngestAnomalyParams {
  /**
   * How many times the trailing baseline a batch must exceed to trip. Ten, not two: the
   * cost of a false trip is a quarantined batch on the biggest fire day of the season, and
   * the artifacts this catches are one to two orders of magnitude above baseline, not one
   * standard deviation.
   */
  readonly ratio: number;
  /**
   * The floor below which nothing trips, in rows. In February a source can return two rows
   * per poll, and ten times two is twenty — a number the first real fire of the year
   * reaches. The floor is what stops the breaker from being armed against normal spring.
   */
  readonly minBatchSize: number;
  /**
   * Successful polls needed before the breaker is armed at all. Twelve is two hours at the
   * 10-minute cadence: enough that a freshly deployed worker, or one that has just come
   * back from an outage, does not quarantine its own first real batch.
   */
  readonly minSamples: number;
  /**
   * How many trailing successful polls the baseline is taken over. Twenty-four is four
   * hours — long enough to span an overpass gap, short enough to track a season that grows
   * from tens of detections in April to thousands in August.
   */
  readonly windowSize: number;
}

export const INGEST_ANOMALY: VersionedConfig<IngestAnomalyParams> = defineConfig(
  'ingest_anomaly',
  'ingest_anomaly_v1',
  { ratio: 10, minBatchSize: 500, minSamples: 12, windowSize: 24 } as const,
);

export function assertIngestAnomalyParams(params: IngestAnomalyParams): void {
  if (!Number.isFinite(params.ratio) || params.ratio <= 1) {
    throw new RangeError(
      `ingest anomaly ratio must be greater than 1, got ${String(params.ratio)}; a ratio of 1 ` +
        'or less quarantines every batch that is merely busier than the last one',
    );
  }
  for (const [name, value] of [
    ['minBatchSize', params.minBatchSize],
    ['minSamples', params.minSamples],
    ['windowSize', params.windowSize],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `ingest anomaly ${name} must be a positive integer, got ${String(value)}`,
      );
    }
  }
  if (params.minSamples > params.windowSize) {
    throw new RangeError(
      `ingest anomaly minSamples (${String(params.minSamples)}) cannot exceed windowSize ` +
        `(${String(params.windowSize)}); the breaker would never arm`,
    );
  }
}
