/**
 * The quarantine side of ingest, as the core sees it (TASKS C2; 01 §6.1.3).
 *
 * Two write shapes and one read. The write shapes are separate because the two things
 * they record fail independently: a batch row is written for every successful poll,
 * anomalous or not, while quarantine entries exist only when something was wrong. Folding
 * them into one call would mean the common case carries an empty array through the
 * adapter and the uncommon case has no way to be retried on its own.
 *
 * The read exists because the anomaly breaker is a pure function over trailing batch
 * sizes (`anomaly-breaker.ts`) and something has to supply them. It returns sizes and not
 * batch rows: the breaker must not be able to see the previous verdicts, or a single
 * false trip would start feeding on itself.
 *
 * Like `detection-store.ts`, everything here is append-only by grant. A quarantined batch
 * is never un-quarantined by an UPDATE — it is judged again from what was recorded, and
 * a human clearing it does so through a path the ingest role does not hold.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { AnomalyVerdict } from '../ingest/anomaly-breaker.js';

/**
 * Whether the entry indicts one row or the whole response.
 *
 * `row` is a single line that could not be read or could not be believed — it carries its
 * delivered bytes. `batch` is the breaker's verdict on the response as a whole: the rows
 * themselves are individually fine, so there are no bytes to point at, and the evidence
 * is the numbers on the batch row instead.
 */
export type QuarantineScope = 'row' | 'batch';

export interface QuarantineEntry {
  readonly source: SourceId;
  /**
   * The batch's `available_at`. This, with `source`, is what joins an entry to its batch —
   * see `IngestBatchRecord` for why there is no id here.
   */
  readonly availableAt: number;
  readonly scope: QuarantineScope;
  /** 1-based among data rows, so an entry and a CSV line address the same thing. `null` on a batch entry. */
  readonly rowIndex: number | null;
  /**
   * Set when the row got far enough to be identified — a validation violation has one, an
   * unparseable line does not. It is deliberately not a foreign key: a quarantined row may
   * never have landed in `detections` at all.
   */
  readonly detectionUid: string | null;
  /** Human-readable and machine-greppable: parser reason, violation list, or breaker verdict. */
  readonly reason: string;
  /** The line as delivered. Required on `row`, absent on `batch`. */
  readonly raw: string | null;
}

/**
 * One successful poll, counted. Written whether or not anything was wrong, because the
 * baseline the breaker reads is built from these rows and a batch that is missing from
 * the history is a batch that quietly lowers the bar for the next one.
 */
export interface IngestBatchRecord {
  readonly source: SourceId;
  readonly availableAt: number;
  /** Rows the response contained: what the breaker judged. */
  readonly received: number;
  /** Rows this poll actually added; the rest were already held (`day_range=2` overlap). */
  readonly inserted: number;
  readonly alreadyPresent: number;
  /** Rows the parser could not read. */
  readonly rejected: number;
  /** Rows that parsed but failed E1 validation. */
  readonly quarantined: number;
  readonly anomalyVerdict: AnomalyVerdict;
  readonly anomalyTripped: boolean;
  readonly baseline: number | null;
  readonly ratio: number | null;
  readonly ingestConfigVersion: string;
  readonly pollingBboxVersion: string;
  readonly sourceRegistryVersion: string;
}

export interface QuarantineStore {
  /**
   * Records a successful poll's counts and the breaker's verdict on it.
   *
   * Deliberately not keyed to the quarantine entries by an id. `(source, available_at)`
   * already identifies a batch, and joining on it means the two writes have no ordering
   * dependency on each other: entries can land before the batch row, the batch row can
   * land alone, and neither leaves a dangling reference behind.
   */
  recordBatch(batch: IngestBatchRecord): Promise<void>;

  /** Records rejected lines and failed validations. A no-op on an empty array. */
  quarantine(entries: readonly QuarantineEntry[]): Promise<void>;

  /**
   * The `received` counts of the most recent successful polls for a source, newest first,
   * at most `limit` of them — the trailing window `evaluateBatch` measures against.
   *
   * Batches that themselves tripped the breaker are *included*. Excluding them looks
   * prudent and is not: a genuine step change in provider volume would then keep tripping
   * forever, because the history could never learn the new normal, and alerting would stay
   * off for days. Including them lets the median self-heal after about half a window while
   * still catching a one-off artifact — the case the breaker actually exists for.
   */
  recentBatchSizes(source: SourceId, limit: number): Promise<readonly number[]>;
}
