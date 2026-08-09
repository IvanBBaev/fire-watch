/**
 * The archive, as the core sees it.
 *
 * `detections` is append-only — not by convention but by grant: the runtime role holds
 * SELECT and INSERT and nothing else (migration 001, ADR-002 A1.1). So the port offers
 * exactly one write shape, and re-ingesting a row that is already there is a no-op
 * rather than an update. That is what makes a double poll harmless (TASKS C1) and what
 * makes the overlap of `day_range=2` free instead of destructive.
 *
 * A poll *attempt* is recorded whether or not it produced rows, because "no fires" and
 * "no data" must never look the same (DATA-SOURCES §A1.1 pitfall 10).
 */

import type { SourceId } from '@fire-watch/contracts';

/**
 * The tier a written row carries. Wider than the registry's `ProductTier`: `SP` is not a
 * queryable product but a processing state a row arrives in, and it is never null on a
 * stored row — the CHECK on `detections.product_tier` says so.
 */
export type WrittenProductTier = 'NRT' | 'SP' | 'GEO';

/** Same three values as the parser's normalization and the `confidence` CHECK. */
export type DetectionConfidence = 'low' | 'nominal' | 'high';

/** A detection as the archive stores it — one row of `detections`. */
export interface DetectionRecord {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly productTier: WrittenProductTier;
  /** `YYYY-MM-DDTHH:MM:00Z` — stored exactly as it was hashed (GLOSSARY §1b). */
  readonly acqTsIso: string;
  /** Epoch milliseconds; the adapter renders the timestamp. */
  readonly availableAt: number;
  /** Canonical decimal text, 5 fraction digits. Text, so `numeric` round-trips it. */
  readonly lat: string;
  readonly lon: string;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  /** `null` is "not reported"; `0` is a reported zero (pitfall 9). */
  readonly frpMw: number | null;
  readonly brightnessK: number | null;
  readonly brightnessBgK: number | null;
  readonly confidenceRaw: string;
  readonly confidence: DetectionConfidence;
  readonly dayNight: 'D' | 'N' | null;
  readonly collectionVersion: string | null;
  readonly sourceRegistryVersion: string;
  readonly ingestConfigVersion: string;
  /**
   * The ingest anomaly breaker tripped on the batch this row arrived in (TASKS C2). Set
   * here and never afterwards: the table is append-only by grant, so the flag has to be
   * decided before the insert rather than applied by an UPDATE the runtime role could not
   * issue. Alerting skips flagged rows; the map and the archive keep them.
   */
  readonly quarantined: boolean;
}

export interface AppendResult {
  readonly received: number;
  readonly inserted: number;
  /**
   * `received - inserted`: rows the archive already held. Expected and healthy — the
   * poll window overlaps on purpose — but a batch that is *entirely* already-present
   * across many cycles means the source has stopped producing, which is worth a metric.
   */
  readonly alreadyPresent: number;
}

/** One row of `source_status`, expressed as the transition a single attempt causes. */
export interface PollAttempt {
  readonly source: SourceId;
  readonly attemptAt: number;
  readonly succeeded: boolean;
  /** Rows parsed out of the response. Zero on a healthy empty poll. */
  readonly receivedRows: number;
  /** Set when and only when the attempt failed; it clears on the next success. */
  readonly error: string | null;
}

export interface DetectionStore {
  /**
   * Appends a batch, skipping rows already present. Never updates: a second observation
   * of the same detection is the same detection (ADR-002 A1.1), and a later collection
   * version of it is discarded rather than merged in.
   */
  appendDetections(records: readonly DetectionRecord[]): Promise<AppendResult>;

  /** Records the attempt, successful or not, against the source's freshness state. */
  recordPollAttempt(attempt: PollAttempt): Promise<void>;
}
