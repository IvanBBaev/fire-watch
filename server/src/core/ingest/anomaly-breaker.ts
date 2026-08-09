/**
 * The ingest anomaly breaker (TASKS C2; 01 §6.1.3 step 3).
 *
 * A pure decision: given the size of the batch that just arrived and the sizes of the
 * batches before it, should this one be quarantined and alerting skipped? No I/O, no
 * clock — the trailing sizes are handed in, so the same numbers always produce the same
 * verdict and a quarantined batch can be re-judged from the archive a year later.
 *
 * **Why batch size and not inserted count.** Review 01's sketch keys the guard on the
 * *inserted* count, and TASKS C2 keys it on batch size; the difference matters and batch
 * size wins. `day_range=2` means every poll returns the same two-day window, so the
 * received count is a large, slowly-moving quantity — exactly what a ratio test needs. The
 * inserted count is the handful of rows that are new since the last poll ten minutes ago:
 * a median near two or three, where ten times the baseline is a number the first real fire
 * of the afternoon reaches. Keying on inserted would build a false-positive machine.
 *
 * The second reason is structural. Deciding before the write is what lets the verdict be
 * written *with* the rows, as a column set at insert time. Review 01's version decides
 * after `appendIfNew` and then has to `UPDATE ... SET status='quarantined'` — and the
 * ingest role holds `SELECT, INSERT` on `detections` and nothing else, on purpose.
 *
 * **A tripped batch still lands.** It lands flagged. The 2026 season cannot be re-polled
 * and raw capture is the value (IMPLEMENTATION-PLAN WP1), so the breaker never discards:
 * it marks, alerting skips the marked rows, and a human clears them. Dropping the batch
 * would make a false trip on the worst fire day of the season permanent data loss.
 */

import {
  INGEST_ANOMALY,
  assertIngestAnomalyParams,
  type IngestAnomalyParams,
} from '../config/ingest-anomaly.js';

/**
 * Why the breaker decided what it decided. Recorded verbatim on the batch row, because
 * "not tripped" has four quite different meanings and an operator investigating a flood
 * that got through needs to know which one applied.
 */
export type AnomalyVerdict =
  'not_enough_history' | 'below_floor' | 'within_baseline' | 'above_baseline';

export interface AnomalyDecision {
  readonly tripped: boolean;
  readonly verdict: AnomalyVerdict;
  /** The trailing median, or `null` when there was not enough history to take one. */
  readonly baseline: number | null;
  /**
   * `batchSize / baseline`, rounded to two decimals. `null` when there is no baseline, and
   * also when the baseline is zero — a ratio of infinity is not a number a JSON archive
   * can keep, and the verdict already says what happened.
   */
  readonly ratio: number | null;
  /** The config version the decision ran under, so a replay can pin it. */
  readonly configVersion: string;
}

export interface EvaluateBatchOptions {
  /** Defaults to `ingest_anomaly_v1`; a replay passes the version it is reproducing. */
  readonly config?: typeof INGEST_ANOMALY;
}

/**
 * `trailing` is the batch sizes of the *successful* polls before this one, most recent
 * first. Failed polls contribute nothing — a source that was down for an hour did not
 * observe zero fires, and letting an outage push the baseline to zero would arm the
 * breaker against the first batch after every recovery.
 */
export function evaluateBatch(
  batchSize: number,
  trailing: readonly number[],
  options: EvaluateBatchOptions = {},
): AnomalyDecision {
  const config = options.config ?? INGEST_ANOMALY;
  const params: IngestAnomalyParams = config.values;
  assertIngestAnomalyParams(params);
  if (!Number.isInteger(batchSize) || batchSize < 0) {
    throw new RangeError(`batch size must be a non-negative integer, got ${String(batchSize)}`);
  }

  const window = trailing.slice(0, params.windowSize);
  const decision = (
    verdict: AnomalyVerdict,
    baseline: number | null,
    tripped: boolean,
  ): AnomalyDecision => ({
    tripped,
    verdict,
    baseline,
    ratio:
      baseline === null || baseline === 0 ? null : Math.round((batchSize / baseline) * 100) / 100,
    configVersion: config.version,
  });

  if (window.length < params.minSamples) {
    return decision('not_enough_history', null, false);
  }

  const baseline = median(window);

  // The floor is checked after the baseline is taken so the number is still recorded: a
  // quiet winter batch is not an anomaly, but the baseline it sat against is worth keeping.
  if (batchSize < params.minBatchSize) {
    return decision('below_floor', baseline, false);
  }

  // A baseline of zero means twelve or more successful polls that all came back empty. A
  // batch of `minBatchSize` rows out of that silence is the artifact this exists for — a
  // genuine first fire arrives as tens of pixels, not hundreds.
  const tripped = baseline === 0 ? true : batchSize > params.ratio * baseline;
  return decision(tripped ? 'above_baseline' : 'within_baseline', baseline, tripped);
}

/**
 * The median, not the mean. A mean is dragged upward by the very flood being detected —
 * two artifact batches in the trailing window would raise the bar enough for the third to
 * pass, which is precisely backwards.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError('median of an empty window is undefined');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
