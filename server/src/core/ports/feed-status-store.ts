/**
 * Freshness bookkeeping for the rows `source_status` cannot hold (TASKS C4).
 *
 * `source_status.source` is a foreign key into the frozen `sources` registry, so the
 * unregistered feeds (`effis:layers`, `weather:context`, `eumetsat:clm`) and the
 * scheduled jobs can never be rows in it — and GLOSSARY §1a keeps them unregistered on
 * purpose, because they produce no detections. They still have freshness budgets (C5),
 * so their attempts have to be recorded *somewhere* the health endpoint can read.
 *
 * Same philosophy as `recordPollAttempt` on the detection side: the record is written by
 * the job that did the work, as part of the work, never by a separate call someone has
 * to remember — a freshness surface updated out of band is a freshness surface that can
 * lie about a feed nobody is fetching.
 */

import type { FreshnessRowId, MonitoredSourceId } from '@fire-watch/contracts';

import type { EpochMs } from './clock.js';

/**
 * Everything with a freshness budget that `source_status` cannot answer for: the
 * unregistered feeds and the budgeted jobs. Derived, not listed, so a new monitored id
 * lands on exactly one side of the split by construction.
 */
export type RecordableRowId = Exclude<FreshnessRowId, MonitoredSourceId>;

export interface FeedAttempt {
  readonly row: RecordableRowId;
  readonly attemptAt: EpochMs;
  /** Whether the attempt did its whole job — this is what the freshness age tracks. */
  readonly succeeded: boolean;
  /** Whether it brought home new bytes. Success with nothing new is a quiet day, not an outage. */
  readonly hadData: boolean;
  readonly error: string | null;
}

export interface FeedStatusStore {
  /**
   * Records one attempt, success or failure alike — the distinction between "never ran"
   * and "never worked" is the evaluator's most important input. Throws on store failure;
   * the cycle reports that as its own outcome rather than letting it vanish.
   */
  recordAttempt(attempt: FeedAttempt): Promise<void>;
}
